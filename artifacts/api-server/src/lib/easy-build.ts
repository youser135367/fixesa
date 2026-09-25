import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import sodium from "libsodium-wrappers";
import { unzipSync } from "fflate";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  easyBuildBuildsTable,
  easyBuildEventsTable,
  easyBuildSessionsTable,
  type EasyBuildBuild,
  type EasyBuildSession,
} from "@workspace/db";
import { androidBuildWorkflow } from "./android-workflow";

const SESSION_COOKIE = "easy_build_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const GITHUB_API = "https://api.github.com";
const MAX_BUILD_ATTEMPTS = 15;

type BuildStatus = EasyBuildBuild["status"];
type EventLevel = "info" | "success" | "warning" | "error";

export type BuildEventView = {
  id: number;
  message: string;
  level: EventLevel;
  createdAt: string;
};

export type BuildView = {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  status: BuildStatus;
  attempt: number;
  maxAttempts: number;
  runId: number | null;
  artifactId: number | null;
  events: BuildEventView[];
  createdAt: string;
  updatedAt: string;
};

export type GithubSessionContext = {
  session: EasyBuildSession;
  accessToken: string;
};

export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubRequestError";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const piece of header.split(";")) {
    const separator = piece.indexOf("=");
    if (separator < 0) continue;
    if (piece.slice(0, separator).trim() === name) {
      return decodeURIComponent(piece.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function appendCookie(res: Response, value: string, maxAgeSeconds: number) {
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const previous = res.getHeader("Set-Cookie");
  const next = Array.isArray(previous) ? [...previous, cookie] : previous ? [String(previous), cookie] : [cookie];
  res.setHeader("Set-Cookie", next);
}

function clearCookie(res: Response) {
  appendCookie(res, "", 0);
}

function sessionDigest(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId).digest("hex");
}

function tokenEncryptionKey(): Buffer {
  return scryptSync(requiredEnv("SESSION_SECRET"), "easy-build-github-token-v1", 32);
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

function decryptToken(value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Stored GitHub token is invalid.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tokenEncryptionKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function getOrCreateEasyBuildSession(
  req: Request,
  res: Response,
): Promise<EasyBuildSession> {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (raw) {
    const [existing] = await db
      .select()
      .from(easyBuildSessionsTable)
      .where(
        and(
          eq(easyBuildSessionsTable.id, sessionDigest(raw)),
          gt(easyBuildSessionsTable.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  const rawSessionId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [created] = await db
    .insert(easyBuildSessionsTable)
    .values({ id: sessionDigest(rawSessionId), expiresAt })
    .returning();
  appendCookie(res, rawSessionId, Math.floor(SESSION_TTL_MS / 1000));
  return created;
}

export async function getEasyBuildSession(req: Request): Promise<EasyBuildSession | null> {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (!raw) return null;
  const [session] = await db
    .select()
    .from(easyBuildSessionsTable)
    .where(
      and(
        eq(easyBuildSessionsTable.id, sessionDigest(raw)),
        gt(easyBuildSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

export function sessionToken(session: EasyBuildSession | null): string | null {
  if (!session?.githubAccessTokenEncrypted) return null;
  return decryptToken(session.githubAccessTokenEncrypted);
}

function githubClientId(): string {
  return requiredEnv("GITHUB_CLIENT_ID");
}

function callbackUrl(req: Request): string {
  if (process.env.GITHUB_CALLBACK_URL) return process.env.GITHUB_CALLBACK_URL;
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "")
    .split(",")[0]
    .trim();
  const forwardedProto = (req.get("x-forwarded-proto") ?? "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (req.secure ? "https" : "http");
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) {
    throw new Error("Unable to determine the GitHub OAuth callback URL.");
  }
  return `${proto}://${host}/api/github/auth/callback`;
}

export function githubCallbackUrl(req: Request): string {
  return callbackUrl(req);
}

export async function startGithubOAuth(
  req: Request,
  res: Response,
): Promise<void> {
  const session = await getOrCreateEasyBuildSession(req, res);
  const state = randomBytes(32).toString("base64url");
  await db
    .update(easyBuildSessionsTable)
    .set({ oauthState: state, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(eq(easyBuildSessionsTable.id, session.id));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", githubClientId());
  url.searchParams.set("redirect_uri", callbackUrl(req));
  url.searchParams.set("scope", "repo workflow");
  url.searchParams.set("state", state);
  res.redirect(302, url.toString());
}

export async function finishGithubOAuth(req: Request, res: Response): Promise<void> {
  const rawSession = cookieValue(req, SESSION_COOKIE);
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!rawSession || !code || !state) {
    res.redirect(302, "/?github_error=oauth");
    return;
  }
  const [session] = await db
    .select()
    .from(easyBuildSessionsTable)
    .where(
      and(
        eq(easyBuildSessionsTable.id, sessionDigest(rawSession)),
        gt(easyBuildSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!session?.oauthState || !timingSafeEqual(Buffer.from(state), Buffer.from(session.oauthState))) {
    res.redirect(302, "/?github_error=state");
    return;
  }

  const clientSecret = requiredEnv("GITHUB_CLIENT_SECRET");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: githubClientId(),
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl(req),
    }),
  });
  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    res.redirect(302, "/?github_error=exchange");
    return;
  }

  const user = await githubFetch<{
    id: number;
    login: string;
    avatar_url: string;
  }>(tokenPayload.access_token, "/user");
  await db
    .update(easyBuildSessionsTable)
    .set({
      githubAccessTokenEncrypted: encryptToken(tokenPayload.access_token),
      githubUserId: user.id,
      githubLogin: user.login,
      githubAvatarUrl: user.avatar_url,
      oauthState: null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .where(eq(easyBuildSessionsTable.id, session.id));
  res.redirect(302, "/");
}

export async function disconnectGithub(
  session: EasyBuildSession | null,
  res: Response,
): Promise<void> {
  if (session) {
    await db
      .update(easyBuildSessionsTable)
      .set({
        githubAccessTokenEncrypted: null,
        githubUserId: null,
        githubLogin: null,
        githubAvatarUrl: null,
        oauthState: null,
      })
      .where(eq(easyBuildSessionsTable.id, session.id));
  }
  clearCookie(res);
}

export async function githubFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const message =
      response.status === 404
        ? "GitHub resource not found."
        : response.status === 401
          ? "GitHub authorization expired or was revoked."
          : response.status === 403
            ? "GitHub denied this request. Check repository and workflow permissions."
            : `GitHub request failed (${response.status}).`;
    throw new GithubRequestError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listGithubRepositories(token: string) {
  const repositories: Array<{
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
    description: string | null;
    private: boolean;
    default_branch: string;
    updated_at: string;
  }> = [];
  for (let page = 1; page <= 10; page += 1) {
    const current = await githubFetch<typeof repositories>(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`,
    );
    repositories.push(...current);
    if (current.length < 100) break;
  }
  return repositories.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    description: repo.description,
    private: repo.private,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
  }));
}

export async function setGithubActionsSecret(
  token: string,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  await sodium.ready;
  const encodedRepo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const publicKey = await githubFetch<{ key_id: string; key: string }>(
    token,
    `${encodedRepo}/actions/secrets/public-key`,
  );
  const encryptedValue = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
  );
  await githubFetch<void>(token, `${encodedRepo}/actions/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(encryptedValue, sodium.base64_variants.ORIGINAL),
      key_id: publicKey.key_id,
    }),
  });
}

async function repositoryContents(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<{ sha: string; type: string; content?: string; encoding?: string } | null> {
  const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}?ref=${encodeURIComponent(branch)}`;
  try {
    return await githubFetch<{ sha: string; type: string }>(token, url);
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) return null;
    throw error;
  }
}

export async function missingAndroidProjectFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string[]> {
  const requiredPathGroups = [
    ["build.gradle", "build.gradle.kts"],
    ["settings.gradle", "settings.gradle.kts"],
    ["app/build.gradle", "app/build.gradle.kts"],
    ["app/src/main/AndroidManifest.xml"],
    ["gradle/wrapper/gradle-wrapper.properties"],
    ["gradlew"],
  ];
  const checks = await Promise.all(
    requiredPathGroups.map((group) =>
      Promise.all(group.map((path) => repositoryContents(token, owner, repo, path, branch))),
    ),
  );
  return requiredPathGroups
    .filter((_, index) => !checks[index].some(Boolean))
    .map((group) =>
      group.length === 1 ? group[0] : group.join(" أو "),
    );
}

export async function writeAndroidWorkflow(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  const existing = await repositoryContents(
    token,
    owner,
    repo,
    ".github/workflows/easy-build-android.yml",
    branch,
  );
  const content = Buffer.from(androidBuildWorkflow, "utf8").toString("base64");
  if (existing) {
    if (existing.encoding !== "base64" || !existing.content) {
      throw new Error("Existing workflow content could not be verified safely.");
    }
    const current = existing.content.replace(/\s/g, "");
    if (current === content) return;
    const existingText = Buffer.from(current, "base64").toString("utf8");
    if (!existingText.includes("# Managed by Easy Build")) {
      throw new Error("A different workflow already uses the Easy Build workflow filename.");
    }
  }
  const body = {
    message: "build: configure Easy Build Android workflow",
    content,
    branch,
    ...(existing ? { sha: existing.sha } : {}),
  };
  await githubFetch(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.github/workflows/easy-build-android.yml`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export async function createEasyBuildRecord(
  session: EasyBuildSession,
  owner: string,
  repo: string,
  branch: string,
): Promise<EasyBuildBuild> {
  const id = randomUUID();
  const [build] = await db
    .insert(easyBuildBuildsTable)
    .values({
      id,
      sessionId: session.id,
      owner,
      repo,
      sourceBranch: branch,
      runBranch: branch,
      repairBranch: `easy-build/repair-${id.slice(0, 8)}`,
      status: "queued",
    })
    .returning();
  await appendBuildEvent(build.id, "تم إرسال الطلب إلى GitHub.", "info");
  return build;
}

export async function appendBuildEvent(
  buildId: string,
  message: string,
  level: EventLevel = "info",
): Promise<void> {
  const [last] = await db
    .select({ message: easyBuildEventsTable.message })
    .from(easyBuildEventsTable)
    .where(eq(easyBuildEventsTable.buildId, buildId))
    .orderBy(desc(easyBuildEventsTable.id))
    .limit(1);
  if (last?.message === message) return;
  await db.insert(easyBuildEventsTable).values({ buildId, message, level });
}

export async function setBuildState(
  buildId: string,
  updates: Partial<Pick<EasyBuildBuild, "status" | "runId" | "artifactId" | "attempt">>,
): Promise<void> {
  await db
    .update(easyBuildBuildsTable)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(easyBuildBuildsTable.id, buildId));
}

export async function getOwnedBuild(
  buildId: string,
  sessionId: string,
): Promise<EasyBuildBuild | null> {
  const [build] = await db
    .select()
    .from(easyBuildBuildsTable)
    .where(and(eq(easyBuildBuildsTable.id, buildId), eq(easyBuildBuildsTable.sessionId, sessionId)))
    .limit(1);
  return build ?? null;
}

export async function buildView(build: EasyBuildBuild): Promise<BuildView> {
  const events = await db
    .select()
    .from(easyBuildEventsTable)
    .where(eq(easyBuildEventsTable.buildId, build.id))
    .orderBy(easyBuildEventsTable.id);
  return {
    id: build.id,
    owner: build.owner,
    repo: build.repo,
    branch: build.sourceBranch,
    status: build.status,
    attempt: build.attempt,
    maxAttempts: MAX_BUILD_ATTEMPTS,
    runId: build.runId,
    artifactId: build.artifactId,
    events: events.map((event) => ({
      id: event.id,
      message: event.message,
      level: event.level,
      createdAt: event.createdAt.toISOString(),
    })),
    createdAt: build.createdAt.toISOString(),
    updatedAt: build.updatedAt.toISOString(),
  };
}

function eventForStep(stepName: string): string | null {
  const name = stepName.toLowerCase();
  if (name.includes("check out")) return "جاري تجهيز المستودع في GitHub Actions.";
  if (name.includes("jdk")) return "جاري إعداد JDK.";
  if (name.includes("android sdk")) return "جاري إعداد Android SDK.";
  if (name.includes("build android")) return "جاري بناء APK.";
  if (name.includes("diagnose and repair")) return "جاري تحليل سجل الخطأ وإعداد إصلاح تلقائي.";
  if (name.includes("upload debug apk")) return "نجح البناء، جاري رفع ملف APK.";
  return null;
}

export async function refreshGithubBuild(
  token: string,
  build: EasyBuildBuild,
): Promise<EasyBuildBuild> {
  if (["success", "failure", "cancelled"].includes(build.status)) return build;
  const repoPath = `/repos/${encodeURIComponent(build.owner)}/${encodeURIComponent(build.repo)}`;
  const runsResponse = await githubFetch<{
    workflow_runs: Array<{
      id: number;
      name: string;
      display_title: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      head_branch: string;
    }>;
  }>(token, `${repoPath}/actions/runs?per_page=30&event=workflow_dispatch`);
  const matchingRuns = runsResponse.workflow_runs
    .filter((run) => run.display_title?.includes(build.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const run = matchingRuns[0];
  if (!run) return build;

  const attemptMatch = run.display_title.match(/attempt\s+(\d+)/i);
  const attempt = attemptMatch ? Number(attemptMatch[1]) : Math.max(build.attempt, 1);
  const status: BuildStatus =
    run.status === "completed"
      ? run.conclusion === "cancelled"
        ? "cancelled"
        : "in_progress"
      : "in_progress";
  await setBuildState(build.id, { runId: run.id, attempt, status });

  if (run.status !== "completed") {
    const jobData = await githubFetch<{
      jobs: Array<{
        status: string;
        steps?: Array<{ name: string; status: string; conclusion: string | null }>;
      }>;
    }>(token, `${repoPath}/actions/runs/${run.id}/jobs?per_page=100`);
    const step = jobData.jobs
      .flatMap((job) => job.steps ?? [])
      .find((item) => item.status === "in_progress");
    if (step) {
      const message = eventForStep(step.name);
      if (message) await appendBuildEvent(build.id, message, "info");
    } else {
      await appendBuildEvent(build.id, "جاري التنفيذ على GitHub Actions.", "info");
    }
    const [updated] = await db
      .select()
      .from(easyBuildBuildsTable)
      .where(eq(easyBuildBuildsTable.id, build.id))
      .limit(1);
    return updated ?? build;
  }

  const artifacts = await githubFetch<{
    artifacts: Array<{ id: number; name: string; expired: boolean }>;
  }>(token, `${repoPath}/actions/runs/${run.id}/artifacts?per_page=100`);
  const apkArtifact = artifacts.artifacts.find(
    (artifact) => artifact.name === `easy-build-${build.id}-apk` && !artifact.expired,
  );
  if (apkArtifact) {
    await setBuildState(build.id, {
      status: "success",
      runId: run.id,
      artifactId: apkArtifact.id,
      attempt,
    });
    await appendBuildEvent(build.id, "تم البناء بنجاح وتجهيز ملف APK.", "success");
  } else if (run.conclusion === "cancelled") {
    await setBuildState(build.id, { status: "cancelled", runId: run.id, attempt });
    await appendBuildEvent(build.id, "تم إلغاء البناء من GitHub Actions.", "warning");
  } else if (attempt >= MAX_BUILD_ATTEMPTS && run.conclusion === "failure") {
    await setBuildState(build.id, { status: "failure", runId: run.id, attempt });
    await appendBuildEvent(
      build.id,
      "تعذر إصلاح المشروع تلقائياً بعد 15 محاولة، قد يحتاج المشروع مراجعة يدوية.",
      "error",
    );
  } else {
    const finishedAt = Date.parse(run.created_at);
    const awaitingNextRun = Date.now() - finishedAt < 90_000;
    if (awaitingNextRun) {
      await setBuildState(build.id, { status: "in_progress", runId: run.id, attempt });
      const message = `انتهت المحاولة (${attempt} من ${MAX_BUILD_ATTEMPTS})، جاري تجهيز المحاولة التالية تلقائياً.`;
      await appendBuildEvent(build.id, message, "warning");
    } else {
      await setBuildState(build.id, { status: "failure", runId: run.id, attempt });
      await appendBuildEvent(
        build.id,
        "انتهى تشغيل GitHub Actions دون إنشاء ملف APK. راجع سجل المحاولة الأخيرة.",
        "error",
      );
    }
  }
  const [updated] = await db
    .select()
    .from(easyBuildBuildsTable)
    .where(eq(easyBuildBuildsTable.id, build.id))
    .limit(1);
  return updated ?? build;
}

export async function downloadBuildApk(
  token: string,
  build: EasyBuildBuild,
): Promise<{ bytes: Uint8Array; filename: string }> {
  if (!build.artifactId) throw new Error("APK artifact is not ready.");
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(build.owner)}/${encodeURIComponent(build.repo)}/actions/artifacts/${build.artifactId}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
    },
  );
  if (!response.ok) throw new GithubRequestError("Unable to download the APK artifact.", response.status);
  const archive = new Uint8Array(await response.arrayBuffer());
  if (archive.byteLength > 200 * 1024 * 1024) {
    throw new Error("The APK artifact is too large to download safely.");
  }
  const entries = unzipSync(archive);
  const apk = Object.entries(entries).find(
    ([name, data]) => name.toLowerCase().endsWith(".apk") && data.byteLength > 0,
  );
  if (!apk) throw new Error("The GitHub artifact does not contain an APK file.");
  return {
    bytes: apk[1],
    filename: `${build.repo}-debug.apk`.replace(/[^a-zA-Z0-9._-]/g, "_"),
  };
}

export async function dispatchGithubBuild(
  token: string,
  build: EasyBuildBuild,
): Promise<void> {
  await githubFetch<void>(
    token,
    `/repos/${encodeURIComponent(build.owner)}/${encodeURIComponent(build.repo)}/actions/workflows/easy-build-android.yml/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        ref: build.sourceBranch,
        inputs: {
          build_id: build.id,
          repair_branch: build.repairBranch,
          attempt: "1",
        },
      }),
    },
  );
}

export async function cancelGithubRun(
  token: string,
  build: EasyBuildBuild,
): Promise<void> {
  let runId = build.runId;
  if (!runId) {
    const runs = await githubFetch<{
      workflow_runs: Array<{ id: number; display_title: string }>;
    }>(
      token,
      `/repos/${encodeURIComponent(build.owner)}/${encodeURIComponent(build.repo)}/actions/runs?per_page=30&event=workflow_dispatch`,
    );
    runId = runs.workflow_runs.find((run) => run.display_title?.includes(build.id))?.id ?? null;
  }
  if (!runId) throw new GithubRequestError("GitHub Actions has not created a run yet.", 409);
  await githubFetch<void>(
    token,
    `/repos/${encodeURIComponent(build.owner)}/${encodeURIComponent(build.repo)}/actions/runs/${runId}/cancel`,
    { method: "POST" },
  );
}

export function newBuildId(): string {
  return randomUUID();
}