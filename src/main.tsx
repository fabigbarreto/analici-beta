import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Activity, ArrowRight, LockKeyhole, LogOut } from 'lucide-react';
import { Dashboard, AccessError } from './dashboard';
import type { DashboardData, Period } from './model';
import './styles.css';

const isDemo = import.meta.env.DEV && import.meta.env.MODE === 'demo';
const firebase = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const auth = !isDemo && Object.values(firebase).every(Boolean) ? getAuth(initializeApp(firebase)) : null;

function Brand() {
  return <div className="brand"><span className="brand-icon"><Activity size={21} aria-hidden="true" /></span><span>ANALICI <small>Beta</small></span></div>;
}

async function loadSample(period: Period, signal: AbortSignal) {
  const { demoDashboard } = await import('./demo');
  signal.throwIfAborted();
  return demoDashboard(period);
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(auth ? undefined : null);
  const [authError, setAuthError] = useState('');
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => auth ? onAuthStateChanged(auth, setUser, () => {
    setUser(null);
    setAuthError('Não foi possível verificar sua sessão.');
  }) : undefined, []);

  const loadDashboard = useCallback(async (period: Period, signal: AbortSignal): Promise<DashboardData> => {
    if (isDemo) return loadSample(period, signal);
    if (!user) throw new AccessError('Entre novamente para acessar os dados.');
    const token = await user.getIdToken();
    const response = await fetch('/api/monitoring/dashboard?period=' + period, {
      signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + token },
    });
    if (response.status === 401) throw new AccessError('Sua sessão expirou. Saia e entre novamente.');
    if (response.status === 403) throw new AccessError('Seu acesso ao monitoramento ainda não foi autorizado.');
    if (!response.ok) throw new Error('Não foi possível consultar a telemetria. Tente atualizar.');
    return response.json();
  }, [user]);

  async function login() {
    if (!auth || signingIn) return;
    setAuthError('');
    setSigningIn(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch {
      setAuthError('Não foi possível entrar com o Google. Tente novamente.');
    } finally {
      setSigningIn(false);
    }
  }

  if (!isDemo && !user) {
    return (
      <main className="sign-in-shell">
        <Brand />
        <section className="sign-in-panel">
          <div className="auth-icon"><LockKeyhole aria-hidden="true" size={23} /></div>
          <h1>Monitoramento</h1>
          <p>Entre com uma conta autorizada para acompanhar a infraestrutura.</p>
          {!auth && <p role="status" className="muted">O acesso ao painel ainda não foi configurado.</p>}
          {auth && (
            <button type="button" className="primary-button" disabled={user === undefined || signingIn} onClick={login}>
              {user === undefined ? 'Verificando sessão…' : signingIn ? 'Entrando…' : 'Entrar com Google'}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
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
          <a href="#monitoramento" aria-current="page"><Activity size={17} aria-hidden="true" />Monitoramento</a>
        </nav>
        {auth && user && <button type="button" className="logout" onClick={() => {
          void signOut(auth).catch(() => setAuthError('Não foi possível encerrar a sessão. Tente novamente.'));
        }}><LogOut size={17} aria-hidden="true" />Sair</button>}
      </aside>
      <main className="workspace" id="monitoramento">
        {authError && <p className="session-error" role="alert">{authError}</p>}
        <Dashboard key={user?.uid ?? 'demo'} load={loadDashboard} demo={isDemo} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
