import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowUpLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  GitBranch,
  Github,
  HardDriveDownload,
  Info,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  PackageCheck,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import type { GithubBuild, GithubBuildEvent, GithubRepository } from '@workspace/api-client-react';
import {
  getGetGithubBuildQueryKey,
  getListGithubRepositoriesQueryKey,
  getDownloadGithubBuildApkQueryKey,
  useCancelGithubBuild,
  useDownloadGithubBuildApk,
  useGetGithubAuthStatus,
  useGetGithubBuild,
  useListGithubRepositories,
  useLogoutGithub,
  useStartGithubBuild,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();

const formatDate = (value?: string | null) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-SA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
};

const formatRelative = (value?: string | null) => {
  if (!value) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} د`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `منذ ${hours} س`;
  return `منذ ${Math.floor(hours / 24)} ي`;
};

const statusMeta: Record<string, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  queued: { label: 'في الانتظار', tone: 'amber', icon: Clock3 },
  in_progress: { label: 'قيد التنفيذ', tone: 'violet', icon: RefreshCw },
  success: { label: 'اكتمل بنجاح', tone: 'green', icon: CheckCircle2 },
  failure: { label: 'تعذر البناء', tone: 'red', icon: XCircle },
  cancelled: { label: 'تم الإلغاء', tone: 'slate', icon: X },
};

function AppLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${compact ? 'justify-center' : ''}`} data-testid="brand-easy-build">
      <img src="/easy-build-logo.png" alt="Easy Build" className={compact ? 'h-10 w-10 object-cover object-left rounded-xl' : 'h-11 w-auto max-w-[174px] object-contain'} />
      {compact && <span className="text-base font-extrabold tracking-tight">Easy Build</span>}
    </div>
  );
}

function LoadingCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-5 shadow-card" data-testid="loading-card">
      <div className="mb-5 h-5 w-32 rounded-full animate-shimmer" />
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="mb-3 h-4 rounded-full animate-shimmer" style={{ width: `${92 - index * 16}%` }} />
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const meta = statusMeta[status] ?? statusMeta.queued;
  const Icon = meta.icon;
  const tone = {
    amber: 'bg-[#fff4d6] text-[#9c6a00] border-[#f3d88f]',
    violet: 'bg-[#eeeafd] text-[#5d42bd] border-[#d5c9fa]',
    green: 'bg-[#e2f7ee] text-[#157449] border-[#b7e8ce]',
    red: 'bg-[#fff0ee] text-[#b63b33] border-[#f4c4be]',
    slate: 'bg-[#edf0f4] text-[#5c6878] border-[#d8dfe8]',
  }[meta.tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold ${tone}`} data-testid={`status-build-${status}`}>
      <Icon className={`h-3.5 w-3.5 ${status === 'in_progress' ? 'animate-spin' : ''}`} />
      {meta.label}
    </span>
  );
}

function Sidebar({ connected, user, onLogout, loggingOut }: { connected: boolean; user: { login: string; avatarUrl: string } | null; onLogout: () => void; loggingOut: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="fixed right-4 top-4 z-30 rounded-xl border border-border bg-card p-2.5 shadow-sm lg:hidden" onClick={() => setOpen(true)} aria-label="فتح القائمة" data-testid="button-open-menu">
        <Menu className="h-5 w-5" />
      </button>
      {open && <button className="fixed inset-0 z-30 bg-[#1e2039]/40 lg:hidden" onClick={() => setOpen(false)} aria-label="إغلاق القائمة" data-testid="button-close-overlay" />}
      <aside className={`fixed inset-y-0 right-0 z-40 flex w-[278px] flex-col border-l border-border bg-[#202040] px-5 py-6 text-white transition-transform duration-300 lg:static lg:z-auto lg:translate-x-0 ${open ? 'translate-x-0' : 'translate-x-full'}`} data-testid="sidebar">
        <div className="mb-12 flex items-center justify-between">
          <AppLogo compact />
          <button className="rounded-lg p-1 text-white/55 hover:bg-white/10 hover:text-white lg:hidden" onClick={() => setOpen(false)} aria-label="إغلاق القائمة" data-testid="button-close-menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mb-3 px-3 text-[11px] font-bold tracking-[.16em] text-white/35">مساحة العمل</div>
        <nav className="space-y-1.5">
          <a href="#build" className="flex items-center gap-3 rounded-2xl bg-white/10 px-3.5 py-3 text-sm font-bold text-white" data-testid="link-build-workspace">
            <Zap className="h-4.5 w-4.5 text-[#c0ec3d]" />
            بناء تطبيق
            <ArrowLeft className="mr-auto h-4 w-4 text-white/35" />
          </a>
          <a href="#history" className="flex items-center gap-3 rounded-2xl px-3.5 py-3 text-sm font-semibold text-white/55 transition-colors hover:bg-white/7 hover:text-white" data-testid="link-history">
            <Archive className="h-4.5 w-4.5" />
            سجل البناء
          </a>
        </nav>
        <div className="mt-auto">
          <div className="mb-4 h-px bg-white/10" />
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3.5">
            {connected && user ? (
              <div className="flex items-center gap-3">
                <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-xl border border-white/20" data-testid="img-sidebar-avatar" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold" data-testid="text-sidebar-user">{user.login}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[#b8ef4b]"><span className="h-1.5 w-1.5 rounded-full bg-[#b8ef4b]" /> متصل</p>
                </div>
                <button onClick={onLogout} disabled={loggingOut} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10 hover:text-white disabled:opacity-50" aria-label="فصل GitHub" data-testid="button-sidebar-logout">
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-3 text-white/65">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#f7cb50]" />
                <p className="text-xs leading-6">صل حساب GitHub حتى تبدأ أول عملية بناء.</p>
              </div>
            )}
          </div>
          <div className="mt-5 flex items-center justify-between px-1 text-[10px] text-white/30">
            <span>Easy Build</span><span className="font-mono-app">v1.0.0</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function Header({ connected, user, onLogout, loggingOut }: { connected: boolean; user: { login: string; avatarUrl: string } | null; onLogout: () => void; loggingOut: boolean }) {
  return (
    <header className="flex items-center justify-between border-b border-border bg-background/85 px-5 py-4 backdrop-blur-md lg:px-10">
      <div className="lg:hidden"><AppLogo /></div>
      <div className="hidden items-center gap-2 text-xs font-semibold text-muted-foreground lg:flex">
        <span className="h-2 w-2 rounded-full bg-[#81c784]" />
        المنصة تعمل بشكل طبيعي
      </div>
      <div className="mr-auto flex items-center gap-3 lg:mr-0">
        {connected && user && (
          <>
            <div className="hidden text-left sm:block">
              <p className="text-xs font-bold" dir="ltr">{user.login}</p>
              <p className="text-[10px] text-muted-foreground">حساب GitHub متصل</p>
            </div>
            <img src={user.avatarUrl} alt={user.login} className="h-9 w-9 rounded-xl border-2 border-card shadow-sm" data-testid="img-header-avatar" />
            <button onClick={onLogout} disabled={loggingOut} className="hidden rounded-xl border border-border bg-card px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground sm:block disabled:opacity-50" data-testid="button-header-logout">
              فصل الحساب
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function ConnectCard() {
  const connect = () => window.location.assign('/api/github/auth/login');
  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-[#39376c] bg-[#292755] p-6 text-white shadow-[0_24px_60px_-32px_#292755] sm:p-9" data-testid="card-connect-github">
      <div className="absolute -left-14 -top-20 h-52 w-52 rounded-full bg-[#6a56d8]/30 blur-3xl" />
      <div className="relative flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-3 py-1 text-[11px] font-bold text-[#d2eaa0]">
            <ShieldCheck className="h-3.5 w-3.5" /> اتصال آمن ومباشر
          </div>
          <h2 className="text-2xl font-extrabold leading-[1.35] sm:text-3xl">صِل GitHub، وابنِ تطبيقك من مكانه.</h2>
          <p className="mt-3 max-w-md text-sm leading-7 text-white/65">لا ننسخ مستودعك إلى خادم Easy Build. يعمل البناء داخل GitHub Actions، وعند الفشل يمكن لـ Gemini تحليل السجل والملفات المرتبطة.</p>
        </div>
        <button onClick={connect} className="group flex shrink-0 items-center justify-center gap-2.5 rounded-2xl bg-[#b9eb3c] px-5 py-3.5 text-sm font-extrabold text-[#202040] shadow-[0_12px_30px_-16px_#b9eb3c] transition-transform hover:-translate-y-0.5 active:translate-y-0" data-testid="button-connect-github">
          <Github className="h-5 w-5" />
          الاتصال بـ GitHub
          <ArrowUpLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
        </button>
      </div>
      <div className="relative mt-8 grid grid-cols-1 gap-3 border-t border-white/10 pt-5 text-xs text-white/60 sm:grid-cols-3">
        <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-[#c0ec3d]" /> صلاحيات إعداد البناء</div>
        <div className="flex items-center gap-2"><Code2 className="h-4 w-4 text-[#c0ec3d]" /> كودك يبقى لك</div>
        <div className="flex items-center gap-2"><Terminal className="h-4 w-4 text-[#c0ec3d]" /> سجل واضح لكل خطوة</div>
      </div>
    </section>
  );
}

function RepoCard({ repo, selected, onClick }: { repo: GithubRepository; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`group w-full rounded-2xl border p-4 text-right transition-all ${selected ? 'border-[#7360db] bg-[#f2efff] shadow-[0_10px_28px_-20px_#4f3ea9]' : 'border-border bg-card hover:-translate-y-0.5 hover:border-[#bcb1ef] hover:bg-[#fbfaff]'}`} data-testid={`button-repository-${repo.id}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-[#6853cc] text-white' : 'bg-[#ebe9fa] text-[#6351bd]'}`}>
          <Code2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold" dir="ltr" data-testid={`text-repository-name-${repo.id}`}>{repo.name}</p>
              <p className="mt-0.5 truncate font-mono-app text-[10px] text-muted-foreground" dir="ltr">{repo.fullName}</p>
            </div>
            {selected ? <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#6853cc] text-white"><Check className="h-3 w-3" /></span> : repo.private ? <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
          </div>
          <p className="mt-3 line-clamp-1 text-xs text-muted-foreground">{repo.description || 'لا يوجد وصف لهذا المستودع'}</p>
          <div className="mt-3 flex items-center gap-3 text-[10px] font-semibold text-muted-foreground">
            <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" /><span dir="ltr">{repo.defaultBranch}</span></span>
            <span className="text-border">•</span>
            <span>{formatRelative(repo.updatedAt)}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function RepositoryPicker({ repos, selectedRepo, onSelect }: { repos: GithubRepository[]; selectedRepo: GithubRepository | null; onSelect: (repo: GithubRepository) => void }) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const filtered = useMemo(() => repos.filter((repo) => `${repo.name} ${repo.fullName} ${repo.description ?? ''}`.toLowerCase().includes(search.toLowerCase())), [repos, search]);
  const visible = expanded ? filtered : filtered.slice(0, 4);
  return (
    <section className="rounded-[1.75rem] border border-border bg-card p-5 shadow-card sm:p-6" data-testid="section-repositories">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-[11px] font-bold tracking-[.14em] text-[#7665ce]">01 / المستودع</p>
          <h2 className="text-lg font-extrabold">اختر مشروع Android</h2>
          <p className="mt-1 text-xs text-muted-foreground">اختر مستودعاً متاحاً في حسابك للبدء.</p>
        </div>
        <div className="rounded-xl bg-[#f1effc] p-2.5 text-[#6853cc]"><Github className="h-5 w-5" /></div>
      </div>
      <label className="relative mb-4 block">
        <Search className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background pr-10 pl-4 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-[#7767d6] focus:ring-2 focus:ring-[#7767d6]/15" placeholder="ابحث باسم المشروع..." aria-label="البحث في المستودعات" data-testid="input-search-repositories" />
      </label>
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-8 text-center">
          <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
          <p className="text-sm font-bold">لا توجد نتائج</p>
          <p className="mt-1 text-xs text-muted-foreground">جرّب كلمة بحث مختلفة.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {visible.map((repo) => <RepoCard key={repo.id} repo={repo} selected={selectedRepo?.id === repo.id} onClick={() => onSelect(repo)} />)}
        </div>
      )}
      {filtered.length > 4 && (
        <button onClick={() => setExpanded((value) => !value)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-bold text-[#6853cc] hover:bg-[#f5f3ff]" data-testid="button-toggle-repositories">
          {expanded ? 'عرض أقل' : `عرض كل المستودعات (${filtered.length})`}
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  );
}

function BuildConfig({ repo, branch, setBranch, onStart, loading }: { repo: GithubRepository | null; branch: string; setBranch: (value: string) => void; onStart: () => void; loading: boolean }) {
  return (
    <section className={`rounded-[1.75rem] border border-border bg-card p-5 shadow-card transition-opacity sm:p-6 ${!repo ? 'opacity-60' : ''}`} data-testid="section-build-config">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-[11px] font-bold tracking-[.14em] text-[#7665ce]">02 / الإعداد</p>
          <h2 className="text-lg font-extrabold">راجع إعدادات البناء</h2>
          <p className="mt-1 text-xs text-muted-foreground">سيتم التحقق من بنية المشروع قبل تشغيل GitHub Actions.</p>
        </div>
        <div className="rounded-xl bg-[#edf7df] p-2.5 text-[#548414]"><GitBranch className="h-5 w-5" /></div>
      </div>
      <div className="space-y-4">
        <div className="rounded-2xl bg-[#f7f8fb] p-4">
          <div className="mb-2 flex items-center justify-between text-[11px] font-bold text-muted-foreground"><span>المستودع المحدد</span>{repo?.private && <span className="flex items-center gap-1 text-[#6b57c8]"><LockKeyhole className="h-3 w-3" /> خاص</span>}</div>
          <p className="font-mono-app text-sm font-semibold" dir="ltr">{repo ? repo.fullName : 'لم يتم الاختيار بعد'}</p>
        </div>
        <label className="block">
          <span className="mb-2 block text-xs font-bold">فرع البناء</span>
          <div className="relative">
            <GitBranch className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={branch} onChange={(event) => setBranch(event.target.value)} disabled={!repo} dir="ltr" className="h-12 w-full rounded-xl border border-input bg-background pr-10 pl-4 text-sm font-mono-app outline-none transition-colors focus:border-[#7767d6] focus:ring-2 focus:ring-[#7767d6]/15 disabled:cursor-not-allowed disabled:bg-muted" data-testid="input-build-branch" />
          </div>
        </label>
          <div className="flex gap-3 rounded-2xl border border-[#e7e3fb] bg-[#faf9ff] p-3.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#6551c1]" />
            <p className="text-[11px] leading-5 text-[#625b83]">يتحقق Easy Build من وجود مشروع Android قابل للبناء ومن إعدادات Gradle قبل إرسال العملية.</p>
          </div>
          <div className="flex gap-3 rounded-2xl border border-[#f1dfb5] bg-[#fffaf0] p-3.5">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#a27320]" />
            <p className="text-[11px] leading-5 text-[#80652d]">عند أول بناء، نضيف ملف GitHub Actions ونحفظ مفتاح Gemini كسرّ للمستودع. عند الفشل، يرسل GitHub Actions السجل والملفات المرتبطة إلى Gemini؛ وتُحفظ الإصلاحات في فرع مستقل.</p>
          </div>
        <button onClick={onStart} disabled={!repo || !branch.trim() || loading} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#6551c9] text-sm font-extrabold text-white shadow-[0_12px_24px_-16px_#6551c9] transition-all hover:bg-[#5743ba] disabled:cursor-not-allowed disabled:bg-[#c8c5d5] disabled:shadow-none" data-testid="button-start-build">
          {loading ? <><RefreshCw className="h-4 w-4 animate-spin" /> جارٍ التحقق من المشروع...</> : <><Play className="h-4 w-4 fill-current" /> ابدأ البناء</>}
        </button>
      </div>
    </section>
  );
}

function EventRow({ event }: { event: GithubBuildEvent }) {
  const styles = { info: 'bg-[#e8e9fb] text-[#6354b9]', success: 'bg-[#dcf4e8] text-[#218157]', warning: 'bg-[#fff0cb] text-[#a66e08]', error: 'bg-[#ffe5e1] text-[#bd4137]' };
  const icons = { info: Info, success: Check, warning: AlertCircle, error: XCircle };
  const Icon = icons[event.level] ?? Info;
  return (
    <div className="flex gap-3 border-b border-border/70 py-3.5 last:border-b-0" data-testid={`build-event-${event.id}`}>
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${styles[event.level] ?? styles.info}`}><Icon className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold leading-5">{event.message}</p>
        <p className="mt-1 font-mono-app text-[10px] text-muted-foreground" dir="ltr">{formatDate(event.createdAt)}</p>
      </div>
    </div>
  );
}

function BuildMonitor({ build, liveEvents, onCancel, onDownload, cancelling, downloading }: { build: GithubBuild; liveEvents: GithubBuildEvent[]; onCancel: () => void; onDownload: () => void; cancelling: boolean; downloading: boolean }) {
  const meta = statusMeta[build.status] ?? statusMeta.queued;
  const isActive = build.status === 'queued' || build.status === 'in_progress';
  const events = [...build.events, ...liveEvents.filter((event) => !build.events.some((saved) => saved.id === event.id))];
  return (
    <section className="overflow-hidden rounded-[1.75rem] border border-border bg-card shadow-card" data-testid="section-build-monitor">
      <div className="border-b border-border bg-[#f8f7fe] p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="mb-2 text-[11px] font-bold tracking-[.14em] text-[#7665ce]">03 / التنفيذ</p>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-extrabold">عملية البناء</h2>
              <StatusPill status={build.status} />
            </div>
            <p className="mt-2 font-mono-app text-xs text-muted-foreground" dir="ltr">{build.owner}/{build.repo} · {build.branch}</p>
          </div>
          <div className="text-left">
            <p className="font-mono-app text-[10px] text-muted-foreground" dir="ltr">BUILD-{build.id.slice(0, 8).toUpperCase()}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{formatRelative(build.updatedAt)}</p>
          </div>
        </div>
        <div className="mt-6 flex items-center gap-2">
          <div className={`h-2.5 w-2.5 rounded-full ${build.status === 'success' ? 'bg-[#36a66b]' : build.status === 'failure' ? 'bg-[#d9564f]' : 'bg-[#765fe0] animate-pulse-dot'}`} />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e4e1f5]">
            <div className={`h-full rounded-full transition-all duration-700 ${build.status === 'success' ? 'w-full bg-[#47b777]' : build.status === 'failure' || build.status === 'cancelled' ? 'w-full bg-[#e38780]' : build.status === 'queued' ? 'w-[18%] bg-[#f2bd45]' : 'w-[68%] bg-[#765fe0]'}`} />
          </div>
          <div className={`h-2.5 w-2.5 rounded-full ${build.status === 'success' ? 'bg-[#36a66b]' : 'bg-[#dedbed]'}`} />
        </div>
        <div className="mt-2 flex justify-between text-[10px] font-bold text-muted-foreground"><span>التحقق</span><span>بناء APK</span><span>جاهز للتنزيل</span></div>
      </div>
      <div className="p-5 sm:p-6">
        {build.status === 'success' ? (
          <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-[#b9e6ce] bg-[#effaf4] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3"><div className="rounded-xl bg-[#d5f1e0] p-2 text-[#268457]"><PackageCheck className="h-5 w-5" /></div><div><p className="text-sm font-extrabold text-[#216b4a]">التطبيق جاهز</p><p className="mt-1 text-xs leading-5 text-[#4c7e66]">اكتمل البناء ويمكنك تنزيل ملف APK الآن.</p></div></div>
            <button onClick={onDownload} disabled={downloading} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[#27865a] px-4 text-xs font-extrabold text-white transition-colors hover:bg-[#1f704b] disabled:opacity-60" data-testid="button-download-apk">
              {downloading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {downloading ? 'جارٍ التحضير...' : 'تنزيل APK'}
            </button>
          </div>
        ) : build.status === 'failure' ? (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[#f2c5c0] bg-[#fff5f3] p-4"><div className="rounded-xl bg-[#ffe4df] p-2 text-[#bd4137]"><XCircle className="h-5 w-5" /></div><div><p className="text-sm font-extrabold text-[#9e3932]">لم يكتمل البناء</p><p className="mt-1 text-xs leading-5 text-[#8e5c57]">راجع سجل الأحداث لمعرفة الخطوة التي تحتاج إلى تعديل ثم أعد المحاولة من مستودعك.</p></div></div>
        ) : isActive ? (
         <div className="mb-5 flex items-center justify-between rounded-2xl border border-[#e4defd] bg-[#faf9ff] p-4"><div className="flex items-center gap-3"><div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-[#e9e4ff] text-[#6651c1]"><CircleDashed className="h-5 w-5 animate-spin" /></div><div><p className="text-sm font-extrabold">{meta.label}</p><p className="mt-1 text-xs text-muted-foreground">تصل تحديثات مراحل البناء من GitHub Actions</p></div></div><button onClick={onCancel} disabled={cancelling} className="flex items-center gap-1.5 rounded-xl border border-[#e9c3bf] px-3 py-2 text-xs font-bold text-[#b34c44] hover:bg-[#fff3f1] disabled:opacity-50" data-testid="button-cancel-build"><X className="h-3.5 w-3.5" /> {cancelling ? 'جارٍ الإلغاء' : 'إلغاء البناء'}</button></div>
        ) : (
          <div className="mb-5 rounded-2xl border border-[#dbe0e7] bg-[#f7f8fa] p-4 text-center"><p className="text-sm font-extrabold">تم إيقاف العملية</p><p className="mt-1 text-xs text-muted-foreground">يمكنك بدء عملية جديدة من القائمة أعلاه.</p></div>
        )}
        <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Terminal className="h-4 w-4 text-[#6853c6]" /><h3 className="text-sm font-extrabold">سجل البناء</h3><span className="rounded-md bg-muted px-1.5 py-0.5 font-mono-app text-[10px] text-muted-foreground">{events.length}</span></div><span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-[#5ebf85] animate-pulse-dot' : 'bg-muted-foreground/40'}`} /> {isActive ? 'مباشر' : 'سجل محفوظ'}</span></div>
        <div className="max-h-[330px] overflow-y-auto rounded-2xl border border-border bg-background px-4">
          {events.length ? events.map((event) => <EventRow key={event.id} event={event} />) : <div className="py-12 text-center"><Terminal className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" /><p className="text-xs text-muted-foreground">بانتظار أول سجل من GitHub Actions...</p></div>}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[10px] font-semibold text-muted-foreground"><span className="flex items-center gap-1.5"><Timer className="h-3.5 w-3.5" /> بدأ {formatDate(build.createdAt)}</span><span className="flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5" /> المحاولة {build.attempt} من {build.maxAttempts}</span>{build.runId && <a className="flex items-center gap-1.5 text-[#6651c1] hover:underline" href={`https://github.com/${build.owner}/${build.repo}/actions/runs/${build.runId}`} target="_blank" rel="noreferrer" data-testid="link-github-run"><ExternalLink className="h-3.5 w-3.5" /> فتح في GitHub</a>}</div>
      </div>
    </section>
  );
}

function ConnectedDashboard({ user }: { user: { login: string; avatarUrl: string } }) {
  const reposQuery = useListGithubRepositories({ query: { queryKey: getListGithubRepositoriesQueryKey() } });
  const startBuild = useStartGithubBuild();
  const cancelBuild = useCancelGithubBuild();
  const [selectedRepo, setSelectedRepo] = useState<GithubRepository | null>(null);
  const [branch, setBranch] = useState('');
  const [buildId, setBuildId] = useState<string | null>(null);
  const [startedBuild, setStartedBuild] = useState<GithubBuild | null>(null);
  const [liveEvents, setLiveEvents] = useState<GithubBuildEvent[]>([]);
  const [streamState, setStreamState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const buildQuery = useGetGithubBuild(buildId ?? '', { query: { enabled: Boolean(buildId), queryKey: getGetGithubBuildQueryKey(buildId ?? ''), refetchInterval: buildId ? 5000 : false } });
  const apkQuery = useDownloadGithubBuildApk(buildId ?? '', { query: { enabled: false, queryKey: getDownloadGithubBuildApkQueryKey(buildId ?? '') } });
  const build = buildQuery.data ?? startedBuild;
  const repos = reposQuery.data ?? [];

  useEffect(() => {
    if (selectedRepo && !branch) setBranch(selectedRepo.defaultBranch);
  }, [selectedRepo, branch]);

  useEffect(() => {
    if (!buildId || !build || (build.status !== 'queued' && build.status !== 'in_progress')) return;
    setStreamState('connecting');
    const source = new EventSource(`/api/github/builds/${buildId}/events`);
    source.onopen = () => setStreamState('online');
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as Partial<GithubBuildEvent>;
        if (typeof event.id === 'number' && typeof event.message === 'string') {
          setLiveEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event as GithubBuildEvent]);
        }
        void buildQuery.refetch();
      } catch {
        void buildQuery.refetch();
      }
    };
    source.onerror = () => setStreamState('offline');
    return () => source.close();
  }, [buildId, build?.status, buildQuery.refetch]);

  const start = () => {
    if (!selectedRepo || !branch.trim()) return;
    setNotice(null);
    setLiveEvents([]);
    startBuild.mutate({ data: { owner: selectedRepo.owner, repo: selectedRepo.name, branch: branch.trim() } }, {
      onSuccess: (created) => { setStartedBuild(created); setBuildId(created.id); },
      onError: () => setNotice('تعذر بدء البناء. تأكد من صلاحيات المستودع وإعداداته ثم حاول مرة أخرى.'),
    });
  };
  const cancel = () => {
    if (!buildId) return;
    cancelBuild.mutate({ buildId }, {
      onSuccess: () => { setNotice('تم إرسال طلب إلغاء البناء.'); void buildQuery.refetch(); },
      onError: () => setNotice('تعذر إلغاء العملية حالياً. حاول مرة أخرى.'),
    });
  };
  const download = async () => {
    try {
      const result = await apkQuery.refetch();
      if (!result.data) throw new Error('empty');
      const url = URL.createObjectURL(result.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${build?.repo ?? 'easy-build'}-${build?.branch ?? 'release'}.apk`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setNotice('تعذر تنزيل الملف الآن. حاول مرة أخرى بعد لحظات.');
    }
  };
  return (
    <>
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="mb-3 flex items-center gap-2 text-xs font-bold text-[#6c5ac4]"><span className="h-2 w-2 rounded-full bg-[#6c5ac4]" /> مساحة البناء</div>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl" data-testid="heading-dashboard">أهلاً، {user.login}</h1>
          <p className="mt-2 max-w-lg text-sm leading-7 text-muted-foreground">حوّل مستودع Android إلى ملف APK قابل للتنزيل، مع وضوح كامل في كل خطوة.</p>
        </div>
        <div className="hidden items-center gap-2 rounded-2xl border border-border bg-card px-3.5 py-2.5 text-xs font-bold text-muted-foreground shadow-sm sm:flex"><HardDriveDownload className="h-4 w-4 text-[#6e5bc9]" /> مساحة خاصة بمشاريعك</div>
      </div>
      {notice && <div className="mb-5 flex items-center gap-3 rounded-2xl border border-[#f3dba2] bg-[#fff9e9] px-4 py-3 text-xs font-semibold text-[#88651b]" role="alert" data-testid="status-notice"><AlertCircle className="h-4 w-4 shrink-0" /> {notice}<button className="mr-auto" onClick={() => setNotice(null)} aria-label="إغلاق التنبيه" data-testid="button-dismiss-notice"><X className="h-4 w-4" /></button></div>}
      <div id="build" className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,.95fr)]">
        <div className="space-y-6">
          {reposQuery.isLoading ? <LoadingCard lines={5} /> : reposQuery.isError ? <div className="rounded-3xl border border-[#f1c4be] bg-[#fff6f4] p-6 text-center"><AlertCircle className="mx-auto mb-3 h-7 w-7 text-[#c84b40]" /><p className="text-sm font-extrabold">تعذر تحميل مستودعاتك</p><button onClick={() => void reposQuery.refetch()} className="mt-3 rounded-xl bg-[#bc5148] px-4 py-2 text-xs font-bold text-white" data-testid="button-retry-repositories">إعادة المحاولة</button></div> : <RepositoryPicker repos={repos} selectedRepo={selectedRepo} onSelect={(repo) => { setSelectedRepo(repo); setBranch(repo.defaultBranch); }} />}
          <div id="history" className="hidden rounded-3xl border border-dashed border-border bg-card/50 p-5 lg:block"><div className="flex items-center gap-3"><div className="rounded-xl bg-[#f2f0fb] p-2 text-[#6855c2]"><Archive className="h-4 w-4" /></div><div><p className="text-xs font-extrabold">سجل البناء</p><p className="mt-0.5 text-[11px] text-muted-foreground">سيظهر تاريخ عمليات البناء هنا قريباً.</p></div><MoreHorizontal className="mr-auto h-5 w-5 text-muted-foreground/50" /></div></div>
        </div>
        <div className="space-y-6">
          {build ? <BuildMonitor build={build} liveEvents={liveEvents} onCancel={cancel} onDownload={download} cancelling={cancelBuild.isPending} downloading={apkQuery.isFetching} /> : <BuildConfig repo={selectedRepo} branch={branch} setBranch={setBranch} onStart={start} loading={startBuild.isPending} />}
          {build && build.status !== 'success' && build.status !== 'failure' && build.status !== 'cancelled' && <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3 text-[11px] font-semibold text-muted-foreground"><span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${streamState === 'online' ? 'bg-[#48ad76]' : streamState === 'offline' ? 'bg-[#d89a3d]' : 'bg-[#7560d4] animate-pulse-dot'}`} />{streamState === 'online' ? 'الاتصال المباشر نشط' : streamState === 'offline' ? 'إعادة الاتصال...' : 'جاري الاتصال بسجل البناء...'}</span><button onClick={() => void buildQuery.refetch()} className="flex items-center gap-1.5 text-[#6855c2] hover:underline" data-testid="button-refresh-build"><RefreshCw className="h-3.5 w-3.5" /> تحديث</button></div>}
          {build && (build.status === 'success' || build.status === 'failure' || build.status === 'cancelled') && <button onClick={() => { setBuildId(null); setStartedBuild(null); setLiveEvents([]); }} className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-card py-3 text-xs font-extrabold text-[#6855c2] hover:bg-[#faf9ff]" data-testid="button-new-build"><Zap className="h-4 w-4" /> بدء بناء جديد</button>}
        </div>
      </div>
      <footer className="mt-12 flex flex-col gap-2 border-t border-border pt-5 text-[10px] font-semibold text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-[#6b59c6]" /> لا ننسخ مستودعك إلى خادم Easy Build</span><span>مصمم للمطورين الذين يحبون الوضوح.</span></footer>
    </>
  );
}

function Dashboard() {
  const authQuery = useGetGithubAuthStatus();
  const logout = useLogoutGithub();
  const connected = Boolean(authQuery.data?.connected && authQuery.data.user);
  const user = authQuery.data?.user ?? null;
  const disconnect = () => logout.mutate(undefined, { onSuccess: () => void authQuery.refetch() });
  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="flex min-h-[100dvh] lg:flex-row">
        <Sidebar connected={connected} user={user} onLogout={disconnect} loggingOut={logout.isPending} />
        <main className="min-w-0 flex-1">
          <Header connected={connected} user={user} onLogout={disconnect} loggingOut={logout.isPending} />
          <div className="soft-grid min-h-[calc(100dvh-73px)] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
            <div className="mx-auto max-w-[1240px] animate-rise">
              {!connected && new URLSearchParams(window.location.search).has('github_error') && <div className="mb-5 flex items-center gap-3 rounded-2xl border border-[#f1c4be] bg-[#fff6f4] px-4 py-3 text-xs font-semibold text-[#984a43]" role="alert" data-testid="status-github-oauth-error"><AlertCircle className="h-4 w-4 shrink-0" /> تعذر إكمال الاتصال بـ GitHub. تحقق من إعداد رابط العودة (Callback URL) في تطبيق OAuth ثم حاول مرة أخرى.</div>}
              {authQuery.isLoading ? <div className="grid gap-6 lg:grid-cols-2"><LoadingCard lines={4} /><LoadingCard lines={5} /></div> : connected && user ? <ConnectedDashboard user={user} /> : <><div className="mb-7"><p className="mb-2 text-xs font-bold text-[#6b59c6]">رفيق البناء الخاص بك</p><h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">ابنِ بثقة، <span className="text-[#6956c8]">خطوة بخطوة.</span></h1><p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">طريقة واضحة لتحويل مشروعك الموجود على GitHub إلى تطبيق Android جاهز، من دون نقل الكود أو التخمين.</p></div><ConnectCard /><div className="mt-8 grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border border-border bg-card p-5 shadow-card"><div className="mb-8 flex h-9 w-9 items-center justify-center rounded-xl bg-[#eceafa] text-[#6854c4]"><Github className="h-4.5 w-4.5" /></div><p className="text-sm font-extrabold">اختر من GitHub</p><p className="mt-1.5 text-xs leading-6 text-muted-foreground">كل مستودعاتك في مكان واحد.</p></div><div className="rounded-2xl border border-border bg-card p-5 shadow-card"><div className="mb-8 flex h-9 w-9 items-center justify-center rounded-xl bg-[#edf6df] text-[#5f8c25]"><ShieldCheck className="h-4.5 w-4.5" /></div><p className="text-sm font-extrabold">تحقق قبل البناء</p><p className="mt-1.5 text-xs leading-6 text-muted-foreground">نكتشف المشاكل مبكراً.</p></div><div className="rounded-2xl border border-border bg-card p-5 shadow-card"><div className="mb-8 flex h-9 w-9 items-center justify-center rounded-xl bg-[#fff2d8] text-[#b27a1e]"><Terminal className="h-4.5 w-4.5" /></div><p className="text-sm font-extrabold">سجل حي</p><p className="mt-1.5 text-xs leading-6 text-muted-foreground">تابع كل أمر أثناء تنفيذه.</p></div></div></>}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Router() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;