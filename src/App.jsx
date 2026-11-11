import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  onAuthStateChanged,
  reload,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "@firebase/auth";
import { auth, isFirebaseConfigured } from "./firebase";
import { BsPersonFillAdd } from "react-icons/bs";
import { TbPasswordUser } from "react-icons/tb";
import { FaSignOutAlt } from "react-icons/fa";
import { IoCheckmarkDoneCircleOutline } from "react-icons/io5";

const columns = [
  ["timestamp", "Payment date"],
  ["studentName", "Student name"],
  ["class", "Class"],
  ["paymentType", "Payment type"],
  ["parentEmail", "Parent email"],
  ["itemsSummary", "Items summary"],
  ["total", "Total amount"],
  ["transactionId", "Transaction ID"],
  ["paystackReference", "Paystack reference"],
];
const categories = [
  ["", "All categories"],
  ["tuition", "Tuition"],
  ["lesson", "Lesson"],
  ["social", "Social"],
  ["outstanding", "Outstanding"],
];
const feeCategories = ["tuition", "lesson", "social"];
const categoryRates = {
  tuition: {
    reception: 30100, kg1: 32800, kg2: 32800, nur1: 32800, nur2: 32800,
    basic1: 34450, basic2: 34450, basic3: 34450, basic4: 34450, basic5: 34450,
    jss1: 36300, jss2: 36300, jss3: 46000,
    ss1: 37300, ss2: 37300, ss3: 48000,
  },
  lesson: {
    kg1: 5000, kg2: 5000, nur1: 5000, nur2: 5000,
    basic1: 5000, basic2: 5000, basic3: 5000, basic4: 5000, basic5: 8000,
    jss1: 5000, jss2: 5000, jss3: 8000,
    ss1: 5000, ss2: 5000, ss3: 15000,
  },
};
function displayValue(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function normalizeClass(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function categoryClassKey(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^daycare$/, "reception")
    .replace(/^sss/, "ss");
}

function formatAmount(value) {
  return new Intl.NumberFormat("en-NG", { maximumFractionDigits: 2 }).format(value);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  const day = date.getUTCDate();
  const ordinal = day % 100 >= 11 && day % 100 <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(date);
  const monthYear = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `${weekday}. ${day}${ordinal} ${monthYear}`;
}

function formatAccessCountdown(expiresAt, now) {
  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "Access expired";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `Access expires: ${days}d ${hours}h`;
  if (hours) return `Access expires: ${hours}h ${minutes}m`;
  return `Access expires: ${minutes}m`;
}

function isOutstanding(record) {
  return String(record.paymentType).toLocaleUpperCase() === "OUTSTANDING";
}

function getCategoryFeeItems(summary) {
  const pattern = /(?:(\d+(?:\.\d+)?)\s*x\s+)?(tuition|lesson|social)\s+fee\b/gi;
  return [...String(summary ?? "").matchAll(pattern)].map((match) => ({
    category: match[2].toLocaleLowerCase(),
    quantity: match[1] ? Number(match[1]) : 1,
  }));
}

function recordCategoryAmounts(record) {
  const amounts = new Map();
  if (isOutstanding(record)) return amounts;
  const classKey = categoryClassKey(record.class);
  for (const fee of getCategoryFeeItems(record.itemsSummary)) {
    const rate = fee.category === "social" ? 8000 : categoryRates[fee.category][classKey];
    if (rate !== undefined) {
      amounts.set(fee.category, (amounts.get(fee.category) || 0) + rate * fee.quantity);
    }
  }
  return amounts;
}

function getErrorMessage(error, fallback) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  if (error && typeof error.error === "string" && error.error.trim()) return error.error;
  if (error?.error && typeof error.error.message === "string") return error.error.message;
  return fallback;
}

async function apiRequest(path, user, options = {}) {
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    const error = new Error(getErrorMessage(result.error, "The request could not be completed."));
    error.status = response.status;
    throw error;
  }
  return result;
}

function Brand({ compact = false }) {
  return (
    <div className={`brand-lockup${compact ? " brand-lockup-compact" : ""}`}>
      <img className="school-logo" src="/peacefield.png" alt="Peacefield Private School logo" width="92" height="92" />
      <div className="brand-copy">
        <p className="school-name">Peacefield Private Schools</p>
        {!compact && <><p className="eyebrow">Administration</p><h1>Payment Records</h1><p className="subtitle">A private, read-only view of payment information.</p></>}
      </div>
    </div>
  );
}

function AuthPage({ onAuthenticated, onAuthFlowStarted, onAuthFlowFinished, onAccountCreated, onSignedIn, onInvitationAccepted }) {
  const [mode, setMode] = useState(new URLSearchParams(location.search).has("invite") ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [inviteCode, setInviteCode] = useState(new URLSearchParams(location.search).get("invite") || "");
  const [invitedEmail, setInvitedEmail] = useState("");
  const [inviteLookupStatus, setInviteLookupStatus] = useState(inviteCode ? "loading" : "");
  const [inviteLookupError, setInviteLookupError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verificationUser, setVerificationUser] = useState(null);

  useEffect(() => {
    if (!inviteCode) {
      setInvitedEmail("");
      setEmail("");
      setInviteLookupStatus("");
      setInviteLookupError("");
      return undefined;
    }

    let active = true;
    setInvitedEmail("");
    setEmail("");
    setInviteLookupStatus("loading");
    setInviteLookupError("");
    fetch("/api/auth/invitation-details", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ invitationCode: inviteCode.trim() }),
    })
      .then(async (response) => {
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error("The server returned an invalid response while checking the invitation.");
        }
        if (!response.ok) {
          throw new Error(getErrorMessage(result.error, "Could not verify this invitation."));
        }
        if (typeof result.email !== "string" || !result.email) {
          throw new Error("This invitation does not include a valid email address.");
        }
        if (active) {
          setInvitedEmail(result.email);
          setEmail(result.email);
          setInviteLookupStatus("ready");
        }
      })
      .catch((lookupError) => {
        if (active) {
          setInviteLookupError(lookupError.message || "Could not verify this invitation.");
          setInviteLookupStatus("error");
        }
      });

    return () => { active = false; };
  }, [inviteCode]);

  async function requestOtp() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result.error, "Could not send a verification code."));
      setOtpRequested(true);
      setMessage(result.message || "Check your email for the six-digit verification code.");
    } catch (requestError) {
      setError(requestError.message || "Could not send a verification code.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    onAuthFlowStarted();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "signup") {
        if (!/^\d{6}$/.test(otpCode)) {
          throw new Error("Enter the six-digit code sent to your email before creating an account.");
        }
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        try {
          await updateProfile(credential.user, { displayName: name.trim() });
          await apiRequest("/api/auth/register", credential.user, {
            method: "POST",
            body: JSON.stringify({ displayName: name.trim(), otpCode }),
          });
          await credential.user.reload();
          await credential.user.getIdToken(true);
          await onAuthenticated(credential.user);
          onAccountCreated();
        } catch (registrationError) {
          try {
            await deleteUser(credential.user);
          } catch (cleanupError) {
            throw new Error(`${registrationError.message} The unapproved Firebase account could not be removed (${cleanupError.message}); contact an administrator.`);
          }
          throw registrationError;
        }
      } else {
        const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
        await credential.user.reload();
        if (!credential.user.emailVerified && !otpCode.trim()) {
          setVerificationUser(credential.user);
          setEmail(credential.user.email || email.trim());
          return;
        }
        if (otpCode.trim()) {
          await apiRequest("/api/auth/register", credential.user, {
            method: "POST",
            body: JSON.stringify({
              displayName: credential.user.displayName || "",
              otpCode: otpCode.trim(),
            }),
          });
          await credential.user.reload();
          await credential.user.getIdToken(true);
        }
        await onAuthenticated(credential.user);
        if (otpCode.trim()) onInvitationAccepted();
        else onSignedIn();
      }
    } catch (authError) {
      setError(authError.message || "Authentication failed. Please try again.");
    } finally {
      onAuthFlowFinished();
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    if (mode === "signup" && !/^\d{6}$/.test(otpCode)) {
      setError("Enter the six-digit code sent to your email before continuing with Google.");
      return;
    }
    onAuthFlowStarted();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const credential = await signInWithPopup(auth, new GoogleAuthProvider());
      const displayName = name.trim() || credential.user.displayName || "";
      try {
        if (mode === "signup" && credential.user.email?.toLocaleLowerCase() !== email.trim().toLocaleLowerCase()) {
          throw new Error("The Google account email must match the email address that received the verification code.");
        }
        if (mode === "signup" || otpCode.trim()) {
          await apiRequest("/api/auth/register", credential.user, {
            method: "POST",
            body: JSON.stringify({ displayName, otpCode: otpCode.trim() }),
          });
        }
        if (mode === "signup") onAccountCreated();
        await onAuthenticated(credential.user);
        if (mode !== "signup" && otpCode.trim()) onInvitationAccepted();
        else if (mode !== "signup") onSignedIn();
      } catch (registrationError) {
        const message = getErrorMessage(registrationError, "Your Google account signed in, but staff access could not be set up.");
        try {
          await signOut(auth);
        } catch (signOutError) {
          throw new Error(`${message} Sign-out also failed: ${getErrorMessage(signOutError, "Please sign out manually.")}`);
        }
        throw new Error(message);
      }
    } catch (authError) {
      if (authError.code !== "auth/popup-closed-by-user") {
        setError(getErrorMessage(authError, "Google sign-in failed. Please try again."));
      }
    } finally {
      onAuthFlowFinished();
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setError("Enter your email address first, then choose Forgot password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setMessage("If an account exists for that address, a password reset email has been sent.");
    } catch (authError) {
      setError(authError.message || "Could not send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Brand compact />
        <div className="auth-brand-message">
          <span className="eyebrow">PEACEFIELD · ADMINISTRATION</span>
          <h1>Every payment,<br />clearly accounted for.</h1>
          <p>Secure access to the school’s read-only payment records and reports.</p>
          <div className="auth-trust-note"><span aria-hidden="true">✓</span> Verified staff access only</div>
        </div>
        <span className="auth-panel-footer">Peacefield Private Schools</span>
      </section>
      <section className="auth-form-panel">
        <div className="auth-card">
          <div className="auth-card-heading">
            <p className="eyebrow">SECURE STAFF PORTAL</p>
            <h2>{verificationUser ? "Verify your email" : mode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p>{verificationUser ? "Enter the one-time code sent to your email to verify your account." : mode === "login" ? "Sign in with your school account to continue." : "Use the invitation sent by your administrator."}</p>
          </div>
          {error && <div className="auth-message error-message" role="alert">{error}</div>}
          {mode === "signup" && inviteCode && inviteLookupStatus === "loading" && <div className="auth-message" role="status">Checking your invitation…</div>}
          {mode === "signup" && inviteLookupError && <div className="auth-message error-message" role="alert">{inviteLookupError}</div>}
          {message && <div className="auth-message success-message" role="status">{message}</div>}
          {verificationUser ? (
            <OtpVerificationForm
              user={verificationUser}
              onVerified={onAuthenticated}
              onBack={() => { setVerificationUser(null); setMessage(""); setMode("login"); }}
            />
          ) : (
            <>
              <div className="auth-tabs" role="tablist" aria-label="Account access">
                <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(""); setMessage(""); }}>Sign in</button>
                <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : ""} onClick={() => { setMode("signup"); setError(""); setMessage(""); }}>Create account</button>
              </div>
              <form className="auth-form" onSubmit={submit}>
                {mode === "signup" && <>
                          <label htmlFor="signup-name">Full name</label>
                          <input id="signup-name" autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
                        </>}
                <label htmlFor="auth-email">Work email</label>
                <input id="auth-email" type="email" autoComplete="email" required readOnly={mode === "signup" && Boolean(inviteCode && invitedEmail)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@school.com" />
                {(mode === "signup" || otpRequested) && <>
                  <label htmlFor="auth-otp">Email verification code</label>
                  <div className="otp-input-row">
                    <input id="auth-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required={mode === "signup"} value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
                    <button className="clear-filter" type="button" disabled={busy || !email.trim()} onClick={requestOtp}>{busy ? "Sending…" : otpRequested ? "Resend code" : "Send code"}</button>
                  </div>
                </>}
                <label htmlFor="auth-password">Password</label>
                <input id="auth-password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : "Enter your password"} />
                {mode === "login" && <button className="forgot-link" type="button" onClick={resetPassword}>Forgot password?</button>}
                <button className="primary-button full-width" type="submit" disabled={busy || (mode === "signup" && Boolean(inviteCode) && inviteLookupStatus !== "ready")}>
                  {busy ? "Please wait…" : mode === "login" ? "Sign in securely" : "Create account"}
                </button>
              </form>
              <div className="auth-divider"><span>or</span></div>
              <button className="google-button" type="button" disabled={busy || (mode === "signup" && Boolean(inviteCode) && inviteLookupStatus !== "ready")} onClick={continueWithGoogle}>
                <svg aria-hidden="true" viewBox="0 0 48 48" className="google-icon">
                  <path fill="#4285F4" d="M47.6 24.5c0-1.6-.1-3.1-.4-4.6H24v9h13.2c-.6 2.9-2.3 5.3-4.8 7l7.8 6c4.6-4.2 7.4-10.3 7.4-17.4Z" />
                  <path fill="#34A853" d="M24 48c6.5 0 12-2.1 16-5.8l-7.8-6c-2.1 1.4-4.8 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-8 6.2C6.5 42.6 14.6 48 24 48Z" />
                  <path fill="#FBBC05" d="M10.5 28.6a14.4 14.4 0 0 1 0-9.2l-8-6.2a24 24 0 0 0 0 21.6l8-6.2Z" />
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C35.9 2.4 30.5 0 24 0 14.6 0 6.5 5.4 2.5 13.2l8 6.2C12.4 13.7 17.7 9.5 24 9.5Z" />
                </svg>
                {busy ? "Connecting…" : "Continue with Google"}
              </button>
              <p className="invite-note">Accounts are invitation-only. Enter the email code sent by your administrator. Contact an administrator if you need access.</p>
            </>
          )}
        </div>
        <p className="auth-privacy">Protected by Firebase Authentication · Payment data is read-only</p>
      </section>
    </main>
  );
}

function MonthPicker({ id, label, value, min, max, onChange }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(value.slice(0, 4)) || new Date().getUTCFullYear());
  const pickerRef = useRef(null);
  const triggerRef = useRef(null);
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, index, 1));
    const monthValue = `${year}-${String(index + 1).padStart(2, "0")}`;
    return {
      value: monthValue,
      shortLabel: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(date),
      label: new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(date),
    };
  });
  const selectedLabel = value
    ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${value}-01T00:00:00Z`))
    : "Select month";
  const currentDate = new Date();
  const currentMonth = `${currentDate.getUTCFullYear()}-${String(currentDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const previousYearStart = `${year - 1}-01`;
  const previousYearEnd = `${year - 1}-12`;
  const nextYearStart = `${year + 1}-01`;
  const nextYearEnd = `${year + 1}-12`;
  const canGoPrevious = (!min || previousYearEnd >= min) && (!max || previousYearStart <= max);
  const canGoNext = (!min || nextYearEnd >= min) && (!max || nextYearStart <= max);
  const canSelectCurrent = (!min || currentMonth >= min) && (!max || currentMonth <= max);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event) {
      if (!pickerRef.current?.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function chooseMonth(monthValue) {
    onChange(monthValue);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="month-field">
      <span id={`${id}-label`}>{label} <small>inclusive · UTC</small></span>
      <div className="month-picker" ref={pickerRef}>
        <button
          ref={triggerRef}
          className={`month-trigger${value ? " has-value" : ""}`}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={`${id}-popover`}
          aria-label={`${label}: ${selectedLabel}`}
          onClick={() => {
            if (!open) setYear(Number(value.slice(0, 4)) || new Date().getUTCFullYear());
            setOpen(!open);
          }}
        >
          <span>{selectedLabel}</span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" /></svg>
        </button>
        <div
          id={`${id}-popover`}
          className="month-popover"
          role="dialog"
          aria-label={`Choose ${label.toLocaleLowerCase()} month`}
          hidden={!open}
        >
          <div className="month-picker-heading">
            <button className="year-step" type="button" aria-label="Previous year" disabled={!canGoPrevious} onClick={() => setYear(year - 1)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <span className="month-picker-year" aria-live="polite">{year}</span>
            <button className="year-step" type="button" aria-label="Next year" disabled={!canGoNext} onClick={() => setYear(year + 1)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>
          <div className="month-grid">
            {months.map((month) => {
              const disabled = (min && month.value < min) || (max && month.value > max);
              const inRange = min && max && month.value >= min && month.value <= max;
              return (
                <button
                  key={month.value}
                  className={`month-option${inRange ? " is-in-range" : ""}`}
                  type="button"
                  aria-label={`${month.label} ${year}`}
                  aria-pressed={value === month.value}
                  disabled={Boolean(disabled)}
                  onClick={() => chooseMonth(month.value)}
                >
                  {month.shortLabel}
                </button>
              );
            })}
          </div>
          <div className="month-picker-actions">
            <button type="button" className="clear-filter" disabled={!value} onClick={() => chooseMonth("")}>Clear</button>
            <button type="button" className="clear-filter" disabled={!canSelectCurrent} onClick={() => chooseMonth(currentMonth)}>This month</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomSelect({ label, value, options, onChange, className = "" }) {
  const [open, setOpen] = useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label || options[0]?.label || "";
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!event.target.closest(`[data-select="${label}"]`)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [label, open]);
  return (
    <div className={`text-filter select-filter ${className}`} data-select={label}>
      <span>{label}</span>
      <button className="category-trigger" type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{selectedLabel}</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      {open && <div className={`category-options${label === "Class" ? " class-options" : ""}`} role="listbox" aria-label={label}>
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className="category-option" onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
      </div>}
    </div>
  );
}

function InvitationPanel({ user }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState("");
  const [inviteRecipient, setInviteRecipient] = useState("");
  const [canInvite, setCanInvite] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest("/api/auth/invitations", user)
      .then((result) => {
        if (active) setCanInvite(result.canInvite);
      })
      .catch(() => {
        if (active) setCanInvite(false);
      });
    return () => { active = false; };
  }, [user]);
  if (!canInvite) return null;

  async function createInvite(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setInvite("");
    try {
      const result = await apiRequest("/api/auth/invitations", user, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setInvite(result.signupUrl);
      setInviteRecipient(result.email);
      setEmail("");
    } catch (inviteError) {
      setError(inviteError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="invite-panel">
      <summary><BsPersonFillAdd aria-hidden="true" />Invite staff</summary>
      <form onSubmit={createInvite}>
        <label htmlFor="invite-email">Staff email</label>
        <div className="invite-form-row">
          <input id="invite-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="staff@school.com" />
          <button className="apply-filters" type="submit" disabled={busy}>{busy ? "Sending…" : "Send"}</button>
        </div>
      </form>
      {error && <p className="invite-error" role="alert">{error}</p>}
      {invite && <div className="invite-result">
        <span>Invitation email sent to {inviteRecipient}. It expires in 7 days. You can also share this link:</span>
        <div className="invite-link-row">
          <a href={invite}>{invite}</a>
          <button type="button" className="clear-filter" onClick={() => navigator.clipboard.writeText(invite)}>Copy invite link</button>
        </div>
      </div>}
    </details>
  );
}

function PasswordLinkPanel({ user }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linked, setLinked] = useState(user.providerData.some(({ providerId }) => providerId === "password"));
  const isGoogleUser = user.providerData.some(({ providerId }) => providerId === "google.com");

  if (!isGoogleUser || !user.email) return null;

  async function addPassword(event) {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, password);
      await linkWithCredential(user, credential);
      setLinked(true);
      setPassword("");
      setConfirmPassword("");
    } catch (linkError) {
      setError(getErrorMessage(linkError, "Could not add email and password sign-in."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="invite-panel account-password-panel">
      <summary><TbPasswordUser aria-hidden="true" />{linked ? "Email and password sign-in enabled" : "Add email and password sign-in"}</summary>
      {linked ? (
        <p className="auth-message success-message">You can now sign in with {user.email} and the password you set, or continue with Google.</p>
      ) : (
        <>
          <p className="account-password-help">Set a password for {user.email}. This links password sign-in to your existing account.</p>
          {error && <p className="auth-message error-message" role="alert">{error}</p>}
          <form className="account-password-form" onSubmit={addPassword}>
            <label htmlFor="account-password">New password</label>
            <input id="account-password" type="password" autoComplete="new-password" minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} />
            <label htmlFor="account-password-confirm">Confirm password</label>
            <input id="account-password-confirm" type="password" autoComplete="new-password" minLength={6} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Adding password…" : "Set password"}</button>
          </form>
        </>
      )}
    </details>
  );
}

function Dashboard({ user, onSignOut, onAccessExpired }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Loading payment records.");
  const [error, setError] = useState("");
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [classValue, setClassValue] = useState("");
  const [studentName, setStudentName] = useState("");
  const [itemSummary, setItemSummary] = useState("");
  const [category, setCategory] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ class: "", studentName: "", itemSummary: "", category: "" });
  const [invitationError, setInvitationError] = useState("");
  const [invitationExpiresAt, setInvitationExpiresAt] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const expiryHandled = useRef(false);
  const onAccessExpiredRef = useRef(onAccessExpired);
  onAccessExpiredRef.current = onAccessExpired;

  useEffect(() => {
    let active = true;
    apiRequest("/api/auth/my-invitation", user)
      .then((result) => {
        if (active && typeof result.expiresAt === "string") {
          setInvitationExpiresAt(result.expiresAt);
        }
      })
      .catch((lookupError) => {
        if (active) setInvitationError(lookupError.message);
      });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!invitationExpiresAt || expiryHandled.current) return undefined;
    const remaining = new Date(invitationExpiresAt).getTime() - Date.now();
    function checkExpiry() {
      if (Date.now() < new Date(invitationExpiresAt).getTime() || expiryHandled.current) return;
      expiryHandled.current = true;
      onAccessExpiredRef.current();
    }
    const timeout = window.setTimeout(() => {
      checkExpiry();
    }, Math.max(remaining, 0));
    window.addEventListener("focus", checkExpiry);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("focus", checkExpiry);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [invitationExpiresAt]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      setStatus("Loading payment records…");
      const loaded = [];
      let cursor = null;
      try {
        do {
          const params = new URLSearchParams();
          if (fromMonth) params.set("fromMonth", fromMonth);
          if (toMonth) params.set("toMonth", toMonth);
          if (cursor) params.set("cursor", cursor);
          const result = await apiRequest(`/api/payments${params.size ? `?${params}` : ""}`, user);
          loaded.push(...result.records);
          cursor = result.nextCursor;
          if (result.hasMore && !cursor) throw new Error("The server did not return a pagination cursor.");
          if (!cancelled) setStatus(result.hasMore ? `Loading payment records… ${loaded.length} loaded` : `${loaded.length} payment records loaded.`);
        } while (cursor);
        if (!cancelled) {
          setRecords(loaded);
          setStatus(`${loaded.length} payment records loaded.`);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus("Could not load payment records.");
          setRecords([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [fromMonth, toMonth, user]);

  const classes = useMemo(() => {
    const values = new Map();
    records.forEach((record) => {
      const value = String(record.class ?? "").trim();
      const normalized = normalizeClass(value);
      if (normalized && !values.has(normalized)) values.set(normalized, value);
    });
    return [...values].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true, sensitivity: "base" }))
      .map(([value, label]) => ({ value, label }));
  }, [records]);

  const matchingRecords = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const compactTerm = term.replace(/\s+/g, "");
    return records.filter((record) => {
      const matchesSearch = !term || columns.some(([field]) => {
        const value = (field === "timestamp" ? formatDate(record[field]) : displayValue(record[field])).toLocaleLowerCase();
        return value.includes(term) || (field === "class" && value.replace(/\s+/g, "").includes(compactTerm));
      });
      return matchesSearch &&
        (!appliedFilters.class || normalizeClass(record.class) === appliedFilters.class) &&
        displayValue(record.studentName).toLocaleLowerCase().includes(appliedFilters.studentName) &&
        displayValue(record.itemsSummary).toLocaleLowerCase().includes(appliedFilters.itemSummary);
    });
  }, [records, search, appliedFilters]);

  const visibleRecords = useMemo(() => matchingRecords.filter((record) => {
    if (!appliedFilters.category) return true;
    if (appliedFilters.category === "outstanding") return isOutstanding(record);
    return displayValue(record.itemsSummary).toLocaleLowerCase().includes(appliedFilters.category);
  }), [matchingRecords, appliedFilters.category]);

  const categoryTotals = useMemo(() => {
    const totals = { all: 0, tuition: 0, lesson: 0, social: 0, outstanding: 0, outstandingCount: 0 };
    const amount = (record) => {
      const value = Number(record.total);
      return Number.isFinite(value) ? value : 0;
    };
    matchingRecords.forEach((record) => {
      totals.all += amount(record);
      if (isOutstanding(record)) {
        totals.outstanding += amount(record);
        totals.outstandingCount += 1;
      }
      recordCategoryAmounts(record).forEach((value, feeCategory) => {
        totals[feeCategory] += value;
      });
    });
    return totals;
  }, [matchingRecords]);

  function applyFilters(event) {
    event.preventDefault();
    setAppliedFilters({
      class: classValue,
      studentName: studentName.trim().toLocaleLowerCase(),
      itemSummary: itemSummary.trim().toLocaleLowerCase(),
      category,
    });
  }

  function clearFilters() {
    setClassValue("");
    setStudentName("");
    setItemSummary("");
    setCategory("");
    setAppliedFilters({ class: "", studentName: "", itemSummary: "", category: "" });
  }

  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;

  return (
    <main className="page-shell">
      <header className="page-header">
        <Brand />
        <div className="header-report-mark" aria-label="Payments collection, read-only report">
          <span className="report-mark-icon" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M8 5.5h11l5 5V26H8z" /><path d="M19 5.5V11h5M12 16h8M12 20h8M5 9v18" /></svg>
          </span>
          <span className="report-mark-copy"><span className="report-mark-title">Payments collection</span><span className="report-mark-description">Read-only report</span></span>
        </div>
        <div className="user-controls">
          <span className="user-email">{user.email}</span>
          {invitationExpiresAt && <span className="invitation-countdown" title="Account access ends when this invitation expires. Ask an administrator for a new invitation to restore access.">{formatAccessCountdown(invitationExpiresAt, clock)}</span>}
          {invitationError && <span className="invitation-countdown-error" role="alert">{invitationError}</span>}
          <a className="make-payment-button" href="https://peacefieldpayments.com.ng" target="_blank" rel="noopener noreferrer">Make payment</a>
          <button className="signout-button" type="button" onClick={onSignOut}><FaSignOutAlt aria-hidden="true" />Sign out</button>
        </div>
      </header>

      <div className="account-panels">
        <InvitationPanel user={user} />
        <PasswordLinkPanel user={user} />
      </div>

      <div className="report-controls">
        <MonthPicker id="from-month" label="From" value={fromMonth} max={toMonth} onChange={setFromMonth} />
        <MonthPicker id="to-month" label="To" value={toMonth} min={fromMonth} onChange={setToMonth} />
        <button className="clear-filter" type="button" onClick={() => { setFromMonth(""); setToMonth(""); }}>Clear dates</button>
        <label className="search-field">
          <span className="visually-hidden">Search loaded records</span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></svg>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search loaded records…" autoComplete="off" />
        </label>
        <button className={`filter-toggle${filterOpen ? " is-open" : ""}`} type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4" /></svg>
          <span>Filters</span>{activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}
        </button>
        <span className="record-count" aria-live="polite">{loading ? `${records.length} loaded` : `${visibleRecords.length} shown · ${records.length} loaded`}</span>
      </div>
      {filterOpen && <form className="advanced-filters" onSubmit={applyFilters}>
        <div className="filter-inputs">
          <CustomSelect label="Class" value={classValue} options={[{ value: "", label: "All classes" }, ...classes]} onChange={setClassValue} />
          <label className="text-filter"><span>Student name</span><input type="search" value={studentName} onChange={(event) => setStudentName(event.target.value)} placeholder="Enter a name" autoComplete="off" /></label>
          <label className="text-filter"><span>Item summary</span><input type="search" value={itemSummary} onChange={(event) => setItemSummary(event.target.value)} placeholder="Search item summary" autoComplete="off" /></label>
          <CustomSelect label="Category" className="category-filter" value={category} options={categories.map(([value, label]) => ({ value, label }))} onChange={setCategory} />
        </div>
        <div className="filter-actions"><p>Filters match the complete set of loaded payment records.</p><div><button className="clear-filter" type="button" onClick={clearFilters}>Clear</button><button className="apply-filters" type="submit">Apply filters</button></div></div>
      </form>}

      <section className="results-summary" aria-label="Summary of matching payment records" aria-live="polite">
        <div><span className="summary-label">Matching payments</span><strong>{new Intl.NumberFormat().format(visibleRecords.length)}</strong></div>
        <div><span className="summary-label">Total amount</span><strong>{formatAmount(visibleRecords.reduce((sum, record) => sum + (Number(record.total) || 0), 0))}</strong></div>
      </section>

      <section className="category-totals" aria-label="Payment totals by category" aria-live="polite">
        <h2>Payment totals by category</h2>
        <div className="category-total-grid">
          <SummaryCard label="All matching" value={categoryTotals.all} />
          <SummaryCard label="Tuition payments" value={categoryTotals.tuition} />
          <SummaryCard label="Lesson payments" value={categoryTotals.lesson} />
          <SummaryCard label="Social payments" value={categoryTotals.social} />
          <SummaryCard label="Outstanding balance" value={categoryTotals.outstanding} detail={`${categoryTotals.outstandingCount} payments`} />
        </div>
        <p>Fee totals use the supplied class fee schedule and only count fees listed in the item summary. Day Care uses the Reception rate. Outstanding balances are shown separately.</p>
      </section>

      <section className="table-card" aria-label="Payment records">
        <div className="table-scroll"><table><thead><tr>{columns.map(([field, label]) => <th key={field} scope="col" className={field === "total" ? "numeric" : ""}>{label}</th>)}</tr></thead>
          <tbody>{visibleRecords.length ? visibleRecords.map((record, index) => <tr key={`${record.transactionId || record.paystackReference || "payment"}-${index}`}>
            {columns.map(([field]) => <td key={field} className={`${field === "timestamp" ? "date-cell" : ""}${field === "total" ? " numeric" : ""}`}>{field === "timestamp" ? formatDate(record[field]) : displayValue(record[field])}</td>)}
          </tr>) : <tr><td colSpan={columns.length} className="empty-state">{error || (loading ? "Loading payment records…" : records.length ? "No records match your search or filters." : "No payment records found.")}</td></tr>}</tbody>
        </table></div>
        <div className="table-footer"><div className="table-status"><span id="status-message" data-state={error ? "error" : "info"} role="status">{error || status}</span></div></div>
      </section>
      <footer className="page-footer"><span>Read-only · Data is loaded directly from Firestore</span><span>Search and filters apply to all loaded records</span></footer>
    </main>
  );
}

function SummaryCard({ label, value, detail }) {
  return <div className="category-total"><span className="summary-label">{label}</span><strong>{formatAmount(value)}</strong>{detail && <span className="summary-label">{detail}</span>}</div>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState(isFirebaseConfigured ? "loading" : "not-configured");
  const [authError, setAuthError] = useState("");
  const [verificationUser, setVerificationUser] = useState(null);
  const [notification, setNotification] = useState(null);
  const authFlowInProgress = useRef(false);
  const notificationId = useRef(0);
  const hasInvitation = new URLSearchParams(window.location.search).has("invite");

  function showNotification(message, type = "success") {
    notificationId.current += 1;
    setNotification({ id: notificationId.current, message, type });
  }

  useEffect(() => {
    if (!notification) return undefined;
    const timeout = window.setTimeout(() => setNotification(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [notification]);

  async function signOutUser() {
    try {
      await signOut(auth);
      showNotification("Signed out successfully.");
    } catch (error) {
      showNotification(error.message || "Could not sign out. Please try again.", "error");
    }
  }

  async function activateUser(firebaseUser) {
    await apiRequest("/api/auth/activate", firebaseUser, { method: "POST", body: JSON.stringify({}) });
    setUser(firebaseUser);
    setAuthError("");
    setAuthStatus("active");
  }

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, async (firebaseUser) => {
      if (authFlowInProgress.current) return;
      if (hasInvitation) {
        setUser(null);
        setVerificationUser(null);
        setAuthStatus("signed-out");
        return;
      }
      if (!firebaseUser) {
        setUser(null);
        setVerificationUser(null);
        setAuthStatus("signed-out");
        return;
      }
      setAuthStatus("loading");
      try {
        await reload(firebaseUser);
        if (!firebaseUser.emailVerified) {
          setVerificationUser(firebaseUser);
          setAuthStatus("verification-required");
          return;
        }
        await activateUser(firebaseUser);
      } catch (error) {
        setAuthError(error.message);
        setAuthStatus(error.status === 401 || error.status === 403 ? "access-denied" : "server-error");
      }
    });
  }, [hasInvitation]);

  if (!isFirebaseConfigured) {
    return <SetupPage />;
  }
  if (authStatus === "loading") {
    return <div className="auth-loading"><span className="spinner" />Checking your secure session…</div>;
  }
  if (authStatus === "active" && user) {
    return (
      <>
        <Dashboard
          user={user}
          onSignOut={signOutUser}
          onAccessExpired={() => {
            setAuthError("Access to this account has expired. Ask an administrator for a new invitation, then sign in with its email code.");
            setAuthStatus("access-denied");
          }}
        />
        {notification && <AuthToast key={notification.id} message={notification.message} type={notification.type} />}
      </>
    );
  }
  if (authStatus === "verification-required" && verificationUser) {
    return <VerificationPage user={verificationUser} onSignOut={signOutUser} onVerified={activateUser} />;
  }
  if (authStatus === "access-denied") {
    return <AccessDeniedPage error={authError} onSignOut={signOutUser} />;
  }
  if (authStatus === "server-error") {
    return <AccessDeniedPage error={authError} serverError onSignOut={signOutUser} />;
  }
  return (
    <>
      <AuthPage
        onAuthenticated={activateUser}
        onAuthFlowStarted={() => { authFlowInProgress.current = true; }}
        onAuthFlowFinished={() => { authFlowInProgress.current = false; }}
        onAccountCreated={() => showNotification("Account created successfully. Check your email to verify your account.")}
        onSignedIn={() => showNotification("Signed in successfully.")}
        onInvitationAccepted={() => showNotification("Invitation accepted. Account access has been renewed.")}
      />
      {notification && <AuthToast key={notification.id} message={notification.message} type={notification.type} />}
    </>
  );
}

function AuthToast({ message, type }) {
  return (
    <div className={`auth-toast${type === "error" ? " is-error" : ""}`} role={type === "error" ? "alert" : "status"}>
      <IoCheckmarkDoneCircleOutline aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function OtpVerificationForm({ user, onVerified, onBack, onSignOut }) {
  const [otpCode, setOtpCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result.error, "Could not send a verification code."));
      setMessage(result.message || "Check your email for the six-digit verification code.");
    } catch (requestError) {
      setError(requestError.message || "Could not send a verification code.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/api/auth/register", user, {
        method: "POST",
        body: JSON.stringify({
          displayName: user.displayName || "",
          otpCode,
        }),
      });
      await user.reload();
      await user.getIdToken(true);
      await onVerified(user);
    } catch (verificationError) {
      setError(verificationError.message || "Could not verify this account.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <form className="auth-form" onSubmit={verifyCode}>
      <label htmlFor="verification-otp">Email verification code</label>
      <div className="otp-input-row">
        <input id="verification-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
        <button className="clear-filter" type="button" disabled={busy} onClick={requestCode}>{busy ? "Sending…" : "Send code"}</button>
      </div>
      <button className="primary-button full-width" type="submit" disabled={busy || !/^\d{6}$/.test(otpCode)}>
        {busy ? "Verifying…" : "Verify email and continue"}
      </button>
    </form>
    {message && <div className="auth-message success-message" role="status">{message}</div>}
    {error && <div className="auth-message error-message" role="alert">{error}</div>}
    {onBack ? (
      <button className="text-button" type="button" onClick={onBack}>Return to sign in</button>
    ) : (
      <button className="text-button" type="button" onClick={onSignOut}><FaSignOutAlt aria-hidden="true" />Return to sign in</button>
    )}
  </>;
}

function VerificationPage({ user, onSignOut, onVerified }) {
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">ONE MORE STEP</p><h2>Verify your email</h2><p>Your email address <strong>{user.email}</strong> isn’t verified yet. Request a one-time code and enter it below.</p></div>
    <OtpVerificationForm user={user} onVerified={onVerified} onSignOut={onSignOut} />
  </div></section></main>;
}

function AccessDeniedPage({ error, onSignOut, serverError = false }) {
  const invitationExpired = /access to this account has expired/i.test(error);
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">{serverError ? "SERVER ERROR" : "ACCESS NOT APPROVED"}</p><h2>{invitationExpired ? "Your invitation has expired" : "We couldn’t verify access"}</h2><p>{error}</p><p>{serverError ? "This is a server configuration or temporary service problem, not an approval decision. Contact an administrator and try again after it is resolved." : invitationExpired ? "Ask an administrator to send you a new invitation. Enter its email code and sign in with your existing account to restore access." : "Confirm that you used a valid staff invitation and verified your email address. Contact an administrator if this continues."}</p></div>
    <button className="primary-button full-width" onClick={onSignOut}><FaSignOutAlt aria-hidden="true" />Sign out</button>
  </div></section></main>;
}

function SetupPage() {
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">SETUP REQUIRED</p><h2>Connect Firebase Authentication</h2><p>Add the Firebase web app settings to the Vercel environment variables before using the secure staff portal.</p></div>
    <div className="setup-list"><code>VITE_FIREBASE_API_KEY</code><code>VITE_FIREBASE_AUTH_DOMAIN</code><code>VITE_FIREBASE_PROJECT_ID</code><code>VITE_FIREBASE_APP_ID</code></div>
  </div></section></main>;
}
