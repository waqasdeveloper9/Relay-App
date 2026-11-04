import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCheck,
  FlaskConical,
  Loader2,
  MessageCircle,
  ShieldCheck,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
} from 'lucide-react';
import { api } from '../api';
import { Logo } from '../components/ui';
import { generateStrongPassword } from '../lib/password';

export function Auth({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [brandName, setBrandName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState('');
  const [workspaceUrl, setWorkspaceUrl] = useState('');
  useEffect(() => {
    void api<{ mode: string; appUrl: string; localLoginAllowed: boolean }>('/health')
      .then((h) => {
        setDemo(h.mode === 'demo');
        if (!h.localLoginAllowed && h.appUrl !== location.origin && h.appUrl.startsWith('https:'))
          setWorkspaceUrl(h.appUrl);
      })
      .catch(() => undefined);
  }, []);
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <Logo />
        <span className="eyebrow">YOUR COMMERCE, CONNECTED</span>
        <h1>
          More connection.
          <br />
          Less busywork.
        </h1>
        <p>
          One thoughtful workspace for your orders, customer conversations, and everything in
          between.
        </p>
        <div className="auth-feature">
          <CheckCheck />
          Orders that keep moving.
        </div>
        <div className="auth-feature">
          <MessageCircle />
          Customers who feel heard.
        </div>
        <div className="auth-feature">
          <ShieldCheck />
          Control that stays with you.
        </div>
        <small>Built for Shopify + WhatsApp operations.</small>
      </section>
      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void api(register ? '/auth/register' : '/auth/login', {
              email,
              password,
              ...(register ? { brandName } : {}),
            })
              .then(onSuccess)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <h2>{register ? 'Create your workspace' : 'Welcome back.'}</h2>
          <p>
            {register
              ? 'Start with a 7-day trial. No payment setup required.'
              : 'Sign in to your merchant workspace.'}
          </p>
          {workspaceUrl && (
            <div className="notice">
              Shopify testing is running on the secure workspace.{' '}
              <a href={workspaceUrl}>Open the HTTPS workspace to sign in or register.</a>
            </div>
          )}
          {register && (
            <label className="field">
              <span>Store name</span>
              <input
                required
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder="Your store"
                minLength={2}
                maxLength={80}
              />
            </label>
          )}
          <label className="field">
            <span>Email address</span>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourstore.com"
            />
          </label>
          <div className="field">
            <div className="password-label-row">
              <label htmlFor="merchant-password">Password</label>
              {register && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    try {
                      setPassword(generateStrongPassword());
                      setShowPassword(false);
                      setPasswordNotice(
                        'Strong password generated. Copy it to your password manager before creating your account.',
                      );
                    } catch {
                      setPasswordNotice(
                        'Password generation is unavailable in this browser. Enter a strong password manually.',
                      );
                    }
                  }}
                >
                  <KeyRound size={14} />
                  Generate strong password
                </button>
              )}
            </div>
            <div className="password-input-wrap">
              <input
                id="merchant-password"
                required
                type={showPassword ? 'text' : 'password'}
                autoComplete={register ? 'new-password' : 'current-password'}
                minLength={12}
                maxLength={72}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordNotice('');
                }}
                placeholder="At least 12 characters"
                aria-describedby={passwordNotice ? 'password-notice' : undefined}
              />
              <div className="password-input-actions">
                {register && password && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Copy password"
                    onClick={() => {
                      if (!navigator.clipboard) {
                        setPasswordNotice(
                          'Use Show password and copy it manually in this browser.',
                        );
                        return;
                      }
                      void navigator.clipboard
                        .writeText(password)
                        .then(() => setPasswordNotice('Password copied. Save it securely.'))
                        .catch(() =>
                          setPasswordNotice(
                            'Could not copy automatically. Use Show password and copy it manually.',
                          ),
                        );
                    }}
                  >
                    <Copy size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {passwordNotice && (
              <small id="password-notice" role="status">
                {passwordNotice}
              </small>
            )}
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy || !!workspaceUrl}>
            {busy ? <Loader2 className="spin" size={17} /> : <ArrowRight size={17} />}{' '}
            {register ? 'Create workspace' : 'Sign in'}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError('');
              setPassword('');
              setPasswordNotice('');
              setShowPassword(false);
            }}
          >
            {register ? 'Already have an account? Sign in' : 'New here? Create a workspace'}
          </button>
          {demo && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api('/auth/demo', {})
                  .then(onSuccess)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <FlaskConical size={16} />
              Explore the demo
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
