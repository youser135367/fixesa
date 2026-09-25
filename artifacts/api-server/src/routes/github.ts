import { and, eq, gt } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CancelGithubBuildParams,
  DownloadGithubBuildApkParams,
  GetGithubAuthStatusResponse,
  GetGithubBuildParams,
  GetGithubBuildResponse,
  ListGithubRepositoriesResponse,
  LogoutGithubResponse,
  StartGithubBuildBody,
  StartGithubBuildResponse,
} from "@workspace/api-zod";
import {
  db,
  easyBuildEventsTable,
  easyBuildSessionsTable,
} from "@workspace/db";
import {
  appendBuildEvent,
  buildView,
  cancelGithubRun,
  createEasyBuildRecord,
  disconnectGithub,
  dispatchGithubBuild,
  downloadBuildApk,
  finishGithubOAuth,
  getEasyBuildSession,
  getOwnedBuild,
  githubFetch,
  GithubRequestError,
  listGithubRepositories,
  missingAndroidProjectFiles,
  refreshGithubBuild,
  sessionToken,
  setBuildState,
  setGithubActionsSecret,
  startGithubOAuth,
  writeAndroidWorkflow,
} from "../lib/easy-build";

const router: IRouter = Router();
function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function requireGithubSession(req: Request, res: Response) {
  const session = await getEasyBuildSession(req);
  const token = sessionToken(session);
  if (!session || !token || !session.githubLogin) {
    res.status(401).json({ error: "يرجى الاتصال بحساب GitHub أولاً." });
    return null;
  }
  return { session, token };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof GithubRequestError) return error.message;
  if (
    error instanceof Error &&
    error.message === "A different workflow already uses the Easy Build workflow filename."
  ) {
    return "يوجد ملف سير عمل آخر بهذا الاسم. لم نستبدله حفاظاً على إعدادات مستودعك.";
  }
  if (error instanceof Error && error.message.startsWith("Missing required server configuration:")) {
    return "إعدادات الخدمة غير مكتملة. راجع أسرار المشروع.";
  }
  return "تعذر إكمال العملية مع GitHub. حاول مرة أخرى.";
}

router.get("/github/auth/login", async (req, res): Promise<void> => {
  try {
    await startGithubOAuth(req, res);
  } catch (error) {
    req.log.error({ error }, "Could not start GitHub OAuth");
    res.redirect(302, "/?github_error=configuration");
  }
});

router.get("/github/auth/callback", async (req, res): Promise<void> => {
  try {
    await finishGithubOAuth(req, res);
  } catch (error) {
    req.log.error({ error }, "GitHub OAuth callback failed");
    res.redirect(302, "/?github_error=callback");
  }
});

router.get("/github/auth/status", async (req, res): Promise<void> => {
  try {
    const session = await getEasyBuildSession(req);
    const token = sessionToken(session);
    const data = GetGithubAuthStatusResponse.parse({
      connected: Boolean(token && session?.githubLogin),
      user:
        token && session?.githubLogin
          ? {
              id: session.githubUserId,
              login: session.githubLogin,
              avatarUrl: session.githubAvatarUrl,
            }
          : null,
    });
    res.json(data);
  } catch (error) {
    req.log.error({ error }, "Could not read GitHub auth status");
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/github/auth/logout", async (req, res): Promise<void> => {
  try {
    await disconnectGithub(await getEasyBuildSession(req), res);
    res.json(LogoutGithubResponse.parse({ success: true }));
  } catch (error) {
    req.log.error({ error }, "Could not disconnect GitHub");
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/github/repositories", async (req, res): Promise<void> => {
  const auth = await requireGithubSession(req, res);
  if (!auth) return;
  try {
    const repositories = await listGithubRepositories(auth.token);
    res.json(ListGithubRepositoriesResponse.parse(repositories));
  } catch (error) {
    req.log.error({ error }, "Could not list GitHub repositories");
    res.status(error instanceof GithubRequestError ? error.status : 500).json({
      error: safeErrorMessage(error),
    });
  }
});

router.post("/github/builds", async (req, res): Promise<void> => {
  const parsed = StartGithubBuildBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "اختر المستودع والفرع قبل بدء البناء." });
    return;
  }
  const auth = await requireGithubSession(req, res);
  if (!auth) return;

  let build = await createEasyBuildRecord(
    auth.session,
    parsed.data.owner,
    parsed.data.repo,
    parsed.data.branch,
  );
  try {
    const repoPath = `/repos/${encodeURIComponent(parsed.data.owner)}/${encodeURIComponent(parsed.data.repo)}`;
    const repo = await githubFetch<{
      permissions?: { push?: boolean; admin?: boolean };
      default_branch: string;
    }>(auth.token, repoPath);
    if (!repo.permissions?.push && !repo.permissions?.admin) {
      await setBuildState(build.id, { status: "failure" });
      await appendBuildEvent(
        build.id,
        "لا يملك حساب GitHub صلاحية الكتابة إلى هذا المستودع.",
        "error",
      );
      build = (await getOwnedBuild(build.id, auth.session.id)) ?? build;
      res.status(201).json(StartGithubBuildResponse.parse(await buildView(build)));
      return;
    }

    try {
      await githubFetch(
        auth.token,
        `${repoPath}/branches/${encodeURIComponent(parsed.data.branch)}`,
      );
    } catch (error) {
      if (!(error instanceof GithubRequestError) || error.status !== 404) throw error;
      await setBuildState(build.id, { status: "failure" });
      await appendBuildEvent(
        build.id,
        `الفرع المحدد غير موجود في هذا المستودع: ${parsed.data.branch}`,
        "error",
      );
      build = (await getOwnedBuild(build.id, auth.session.id)) ?? build;
      res.status(201).json(StartGithubBuildResponse.parse(await buildView(build)));
      return;
    }

    const missing = await missingAndroidProjectFiles(
      auth.token,
      parsed.data.owner,
      parsed.data.repo,
      parsed.data.branch,
    );
    if (missing.length) {
      for (const path of missing) {
        await appendBuildEvent(build.id, `الملف الأساسي غير موجود: ${path}`, "error");
      }
      await setBuildState(build.id, { status: "failure" });
      await appendBuildEvent(
        build.id,
        "توقف الفحص قبل البناء. لم يتم تعديل ملفات التطبيق أو تشغيل GitHub Actions.",
        "warning",
      );
      build = (await getOwnedBuild(build.id, auth.session.id)) ?? build;
      res.status(201).json(StartGithubBuildResponse.parse(await buildView(build)));
      return;
    }

    await appendBuildEvent(
      build.id,
      "تم التحقق من ملفات Android الأساسية، وجميعها موجودة.",
      "success",
    );
    const geminiKey = process.env.GEMINI_API_KEY ?? process.env.Gemini_api_key;
    if (!geminiKey) {
      throw new Error("Missing required server configuration: Gemini_api_key");
    }

    await appendBuildEvent(
      build.id,
      "جاري إعداد GitHub Actions ومفتاح Gemini المشفّر لهذا المستودع.",
      "info",
    );
    await setGithubActionsSecret(
      auth.token,
      parsed.data.owner,
      parsed.data.repo,
      "GEMINI_API_KEY",
      geminiKey,
    );
    await writeAndroidWorkflow(
      auth.token,
      parsed.data.owner,
      parsed.data.repo,
      repo.default_branch,
    );
    if (repo.default_branch !== parsed.data.branch) {
      await writeAndroidWorkflow(
        auth.token,
        parsed.data.owner,
        parsed.data.repo,
        parsed.data.branch,
      );
    }
    await appendBuildEvent(
      build.id,
      "تم تجهيز workflow البناء والإصلاح التلقائي على فرع المشروع.",
      "success",
    );
    await dispatchGithubBuild(auth.token, build);
    await setBuildState(build.id, { status: "queued", attempt: 1 });
    await appendBuildEvent(build.id, "تم إطلاق GitHub Actions. البناء يعمل على GitHub.", "info");
  } catch (error) {
    req.log.error({ error }, "Could not dispatch Android build");
    await setBuildState(build.id, { status: "failure" });
    await appendBuildEvent(build.id, safeErrorMessage(error), "error");
  }
  build = (await getOwnedBuild(build.id, auth.session.id)) ?? build;
  res.status(201).json(StartGithubBuildResponse.parse(await buildView(build)));
});

router.get("/github/builds/:buildId", async (req, res): Promise<void> => {
  const params = GetGithubBuildParams.safeParse({ buildId: routeParam(req.params.buildId) });
  if (!params.success) {
    res.status(400).json({ error: "معرّف البناء غير صالح." });
    return;
  }
  const auth = await requireGithubSession(req, res);
  if (!auth) return;
  const build = await getOwnedBuild(params.data.buildId, auth.session.id);
  if (!build) {
    res.status(404).json({ error: "لم يتم العثور على عملية البناء." });
    return;
  }
  try {
    const current =
      build.status === "queued" || build.status === "in_progress"
        ? await refreshGithubBuild(auth.token, build)
        : build;
    res.json(GetGithubBuildResponse.parse(await buildView(current)));
  } catch (error) {
    req.log.warn({ error }, "Could not refresh GitHub build status");
    res.json(GetGithubBuildResponse.parse(await buildView(build)));
  }
});

router.get("/github/builds/:buildId/events", async (req, res): Promise<void> => {
  const auth = await requireGithubSession(req, res);
  if (!auth) return;
  const buildId = routeParam(req.params.buildId);
  let build = await getOwnedBuild(buildId, auth.session.id);
  if (!build) {
    res.status(404).end();
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let closed = false;
  let lastEventId = 0;
  res.on("close", () => {
    closed = true;
  });
  const sendNewEvents = async () => {
    const events = await db
      .select()
      .from(easyBuildEventsTable)
      .where(and(eq(easyBuildEventsTable.buildId, buildId), gt(easyBuildEventsTable.id, lastEventId)))
      .orderBy(easyBuildEventsTable.id);
    for (const event of events) {
      lastEventId = event.id;
      res.write(
        `id: ${event.id}\ndata: ${JSON.stringify({
          id: event.id,
          message: event.message,
          level: event.level,
          createdAt: event.createdAt.toISOString(),
        })}\n\n`,
      );
    }
  };

  res.write(`data: ${JSON.stringify({ connected: true })}\n\n`);
  await sendNewEvents();
  while (!closed && Date.now() - build.createdAt.getTime() < 60 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 7000));
    if (closed) break;
    try {
      const latest = await getOwnedBuild(buildId, auth.session.id);
      if (!latest) break;
      build =
        latest.status === "queued" || latest.status === "in_progress"
          ? await refreshGithubBuild(auth.token, latest)
          : latest;
      await sendNewEvents();
      if (["success", "failure", "cancelled"].includes(build.status)) {
        res.write(`data: ${JSON.stringify({ done: true, status: build.status })}\n\n`);
        break;
      }
      res.write(": keep-alive\n\n");
    } catch (error) {
      req.log.warn({ error }, "GitHub build polling failed");
      res.write(`data: ${JSON.stringify({ warning: "تعذر تحديث الحالة مؤقتاً." })}\n\n`);
    }
  }
  res.end();
});

router.post("/github/builds/:buildId/cancel", async (req, res): Promise<void> => {
  const params = CancelGithubBuildParams.safeParse({ buildId: routeParam(req.params.buildId) });
  if (!params.success) {
    res.status(400).json({ error: "معرّف البناء غير صالح." });
    return;
  }
  const auth = await requireGithubSession(req, res);
  if (!auth) return;
  const build = await getOwnedBuild(params.data.buildId, auth.session.id);
  if (!build) {
    res.status(404).json({ error: "لم يتم العثور على عملية البناء." });
    return;
  }
  try {
    await cancelGithubRun(auth.token, build);
    await setBuildState(build.id, { status: "cancelled" });
    await appendBuildEvent(build.id, "تم إرسال طلب الإلغاء إلى GitHub Actions.", "warning");
    res.json({ success: true });
  } catch (error) {
    req.log.error({ error }, "Could not cancel GitHub build");
    res.status(error instanceof GithubRequestError ? error.status : 500).json({
      error: safeErrorMessage(error),
    });
  }
});

router.get("/github/builds/:buildId/apk", async (req, res): Promise<void> => {
  const params = DownloadGithubBuildApkParams.safeParse({
    buildId: routeParam(req.params.buildId),
  });
  if (!params.success) {
    res.status(400).json({ error: "معرّف البناء غير صالح." });
    return;
  }
  const auth = await requireGithubSession(req, res);
  if (!auth) return;
  const build = await getOwnedBuild(params.data.buildId, auth.session.id);
  if (!build || build.status !== "success") {
    res.status(404).json({ error: "ملف APK غير متاح بعد." });
    return;
  }
  try {
    const apk = await downloadBuildApk(auth.token, build);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Length", apk.bytes.byteLength);
    res.setHeader("Content-Disposition", `attachment; filename="${apk.filename}"`);
    res.send(Buffer.from(apk.bytes));
  } catch (error) {
    req.log.error({ error }, "APK download failed");
    res.status(500).json({ error: "تعذر تنزيل ملف APK من GitHub." });
  }
});

export default router;