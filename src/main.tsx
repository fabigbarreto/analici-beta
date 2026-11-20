import React, { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowRight, HardDrive, LockKeyhole, LogOut } from 'lucide-react';
import { Dashboard, AccessError } from './dashboard';
import type { DashboardData, Period } from './model';
import './styles.css';

const isDemo = import.meta.env.DEV && import.meta.env.MODE === 'demo';
const storagePage = /^\/armazenamento\/?$/.test(window.location.pathname);
if (storagePage) document.title = 'Armazenamento · ANALICI Beta';
type Session = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

function Brand() {
  return <div className="brand"><span className="brand-icon"><Activity size={21} aria-hidden="true" /></span><span>ANALICI <small>Beta</small></span></div>;
}

async function loadSample(period: Period, signal: AbortSignal) {
  const { demoDashboard } = await import('./demo');
  signal.throwIfAborted();
  return demoDashboard(period);
}

function App() {
  const [session, setSession] = useState<Session>('checking');
  const [authError, setAuthError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/auth/session', { signal: controller.signal, cache: 'no-store' });
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
    const response = await fetch('/api/monitoring/dashboard?period=' + period, { signal, cache: 'no-store' });
    if (response.status === 401) {
      const message = 'Sua sessão expirou. Entre novamente.';
      if (!signal.aborted) {
        setSession('signed-out');
        setAuthError(message);
      }
      throw new AccessError(message);
    }
    if (!response.ok) throw new Error('Não foi possível consultar a telemetria. Tente atualizar.');
    return response.json();
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setAuthError('');
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/login', {
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
      const response = await fetch('/api/auth/logout', { method: 'POST' });
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
    <div className="app">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Navegação principal">
          <a href="/" aria-current={storagePage ? undefined : 'page'}>
            <Activity size={17} aria-hidden="true" />Monitoramento
          </a>
          <a href="/armazenamento" aria-current={storagePage ? 'page' : undefined}>
            <HardDrive size={17} aria-hidden="true" />Armazenamento
          </a>
        </nav>
        {!isDemo && <button type="button" className="logout" disabled={submitting} onClick={() => void logout()}>
          <LogOut size={17} aria-hidden="true" />Sair
        </button>}
      </aside>
      <main className="workspace" id={storagePage ? "armazenamento" : "monitoramento"}>
        {authError && <p className="session-error" role="alert">{authError}</p>}
        <Dashboard load={loadDashboard} demo={isDemo} storagePage={storagePage} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
