import React, { useCallback, useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowRight, Bot, HardDrive, ListChecks, LockKeyhole, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Dashboard, AccessError } from './dashboard';
import { Executions } from './executions';
import { Workers } from './workers';
import type { DashboardData, Period } from './model';
import './styles.css';

const isDemo = import.meta.env.DEV && import.meta.env.MODE === 'demo';
type Session = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

function Brand() {
  return <div className="brand"><span className="brand-icon"><Activity size={21} aria-hidden="true" /></span><span>ANALICI <small>Mon</small></span></div>;
}

async function loadSample(period: Period, signal: AbortSignal) {
  const { demoDashboard } = await import('./demo');
  signal.throwIfAborted();
  return demoDashboard(period);
}

function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname.replace(/\/$/, '') || '/');
  const [menuCollapsed, setMenuCollapsed] = useState(() => {
    try { return localStorage.getItem('analici-mon:menu-collapsed') === 'true'; }
    catch { return false; }
  });
  const [session, setSession] = useState<Session>('checking');
  const [authError, setAuthError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const storagePage = pathname === '/mon/armazenamento';
  const executionsPage = pathname === '/mon/execucoes';
  const workersPage = pathname === '/mon/workers';
  const menuAction = menuCollapsed ? 'Expandir menu' : 'Recolher menu';
  const expired = useCallback((message: string) => {
    setSession('signed-out');
    setAuthError(message);
  }, []);

  useEffect(() => {
    const label = workersPage ? 'Sa\u00fade dos Workers' : executionsPage ? 'Execuções' : storagePage ? 'Armazenamento' : 'Monitoramento';
    document.title = label + ' · ANALICI Mon';
  }, [executionsPage, storagePage, workersPage]);

  useEffect(() => {
    const syncPath = () => setPathname(window.location.pathname.replace(/\/$/, '') || '/');
    window.addEventListener('popstate', syncPath);
    return () => window.removeEventListener('popstate', syncPath);
  }, []);

  useEffect(() => {
    try { localStorage.setItem('analici-mon:menu-collapsed', String(menuCollapsed)); }
    catch { /* Keep the preference in memory when storage is unavailable. */ }
  }, [menuCollapsed]);

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const next = event.currentTarget.pathname;
    if (pathname === next) return;
    window.history.pushState(null, '', next);
    setPathname(next);
    window.scrollTo(0, 0);
  }

  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/mon/api/auth/session', { signal: controller.signal, cache: 'no-store' });
        if (response.status === 503) {
          setSession('unavailable');
          return;
        }
        if (!response.ok) throw new Error('Erro ao consultar a sessão.');
        const { authenticated } = await response.json();
        setSession(authenticated === true ? 'signed-in' : 'signed-out');
      } catch {
        if (controller.signal.aborted) return;
        setSession('signed-out');
        setAuthError('Não foi possível verificar a sessão. Tente entrar.');
      }
    })();
    return () => controller.abort();
  }, []);

  const loadDashboard = useCallback(async (period: Period, signal: AbortSignal): Promise<DashboardData> => {
    if (isDemo) return loadSample(period, signal);
    const response = await fetch('/mon/api/monitoring/dashboard?period=' + period, { signal, cache: 'no-store' });
    if (response.status === 401) {
      const message = 'Sua sessão expirou. Entre novamente.';
      if (!signal.aborted) expired(message);
      throw new AccessError(message);
    }
    if (!response.ok) throw new Error('Não foi possível consultar a telemetria. Tente atualizar.');
    return response.json();
  }, [expired]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setAuthError('');
    setSubmitting(true);
    try {
      const response = await fetch('/mon/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: fields.get('username'), password: fields.get('password') }),
      });
      if (response.status === 204) {
        form.reset();
        setSession('signed-in');
      } else {
        const { error } = await response.json();
        setAuthError(error);
      }
    } catch {
      setAuthError('Não foi possível entrar. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    if (submitting) return;
    setSubmitting(true);
    setAuthError('');
    try {
      const response = await fetch('/mon/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Erro ao encerrar a sessão.');
      setSession('signed-out');
    } catch {
      setAuthError('Não foi possível encerrar a sessão. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!isDemo && session !== 'signed-in') {
    return (
      <main className="sign-in-shell">
        <Brand />
        <section className="sign-in-panel">
          <div className="auth-icon"><LockKeyhole aria-hidden="true" size={23} /></div>
          <h1>Monitoramento</h1>
          {session === 'checking' && <p role="status">Verificando sessão…</p>}
          {session === 'unavailable' && <p role="status">O acesso ao painel ainda não foi configurado.</p>}
          {session === 'signed-out' && (
            <form className="sign-in-form" onSubmit={login}>
              <label htmlFor="username">Usuário</label>
              <input id="username" name="username" autoComplete="username" autoCapitalize="none" maxLength={64} required />
              <label htmlFor="password">Senha</label>
              <input id="password" name="password" type="password" autoComplete="current-password" maxLength={512} required />
              <button className="primary-button" disabled={submitting}>
                {submitting ? 'Entrando…' : 'Entrar'}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </form>
          )}
          {authError && <p className="error-text" role="alert">{authError}</p>}
        </section>
      </main>
    );
  }

  return (
    <div className={menuCollapsed ? 'app menu-collapsed' : 'app'}>
      <aside className="sidebar">
        <div className="sidebar-heading">
          <Brand />
          <button type="button" className="menu-toggle" onClick={() => setMenuCollapsed((value) => !value)}
            aria-controls="mon-navigation" aria-expanded={!menuCollapsed} aria-label={menuAction} title={menuAction}>
            {menuCollapsed ? <PanelLeftOpen size={19} aria-hidden="true" /> : <PanelLeftClose size={19} aria-hidden="true" />}
          </button>
        </div>
        <nav id="mon-navigation" aria-label="Navegação principal">
          <a href="/mon/" onClick={navigate} aria-current={storagePage || executionsPage || workersPage ? undefined : 'page'}
            aria-label="Monitoramento" title={menuCollapsed ? 'Monitoramento' : undefined}>
            <Activity size={17} aria-hidden="true" /><span>Monitoramento</span>
          </a>
          <a href="/mon/armazenamento" onClick={navigate} aria-current={storagePage ? 'page' : undefined}
            aria-label="Armazenamento" title={menuCollapsed ? 'Armazenamento' : undefined}>
            <HardDrive size={17} aria-hidden="true" /><span>Armazenamento</span>
          </a>
          <a href="/mon/execucoes" onClick={navigate} aria-current={executionsPage ? 'page' : undefined}
            aria-label="Execuções" title={menuCollapsed ? 'Execuções' : undefined}>
            <ListChecks size={17} aria-hidden="true" /><span>Execuções</span>
          </a>
          <a href="/mon/workers" onClick={navigate} aria-current={workersPage ? 'page' : undefined}
            aria-label="Saúde dos Workers" title={menuCollapsed ? 'Saúde dos Workers' : undefined}>
            <Bot size={17} aria-hidden="true" /><span>Saúde dos Workers</span>
          </a>
        </nav>
        {!isDemo && <button type="button" className="logout" disabled={submitting} onClick={() => void logout()}
          aria-label="Sair" title={menuCollapsed ? 'Sair' : undefined}>
          <LogOut size={17} aria-hidden="true" /><span>Sair</span>
        </button>}
      </aside>
      <main className="workspace" id={workersPage ? 'workers' : executionsPage ? 'execucoes' : storagePage ? 'armazenamento' : 'monitoramento'}>
        {authError && <p className="session-error" role="alert">{authError}</p>}
        {workersPage ? <Workers demo={isDemo} onExpired={expired} />
          : executionsPage ? <Executions demo={isDemo} onExpired={expired} />
          : <Dashboard load={loadDashboard} demo={isDemo} storagePage={storagePage} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
