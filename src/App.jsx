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
import {
  createTuitionExportSheets,
  createTuitionWorkbook,
  getCategoryFeeItems,
  getTuitionPaymentAmount,
  sortRecordsByClass,
  tuitionStudentKey,
} from "./tuition-export.mjs";
import { BsPersonFillAdd } from "react-icons/bs";
import { TbPasswordUser } from "react-icons/tb";
import { FaArrowDown, FaArrowUp, FaFileExcel, FaSignOutAlt } from "react-icons/fa";
import { FaBook, FaCreditCard } from "react-icons/fa6";
import { HiOutlineViewGrid } from "react-icons/hi";
import { FiSearch, FiSettings } from "react-icons/fi";
import { IoCheckmarkDoneCircleOutline } from "react-icons/io5";
import { RiAccountCircleFill } from "react-icons/ri";
import { TbHistory } from "react-icons/tb";

const dashboardTabs = [
  { id: "overview", label: "Overview", icon: HiOutlineViewGrid },
  { id: "tuition", label: "Tuition", icon: FaBook },
  { id: "payments", label: "Payments", icon: FaCreditCard },
  { id: "account", label: "Account", icon: FiSettings },
];

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
    basic34: 34450,
    jss1: 36300, jss2: 36300, jss3: 46000,
    ss1: 37300, ss2: 37300, ss3: 40500,
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
    .replace(/^nursery(?=\d)/, "nur")
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

function buildTuitionStatuses(records) {
  const students = new Map();
  records.forEach((record) => {
    const key = tuitionStudentKey(record, categoryClassKey);
    if (!key) return;
    const rate = categoryRates.tuition[categoryClassKey(record.class)];
    const student = students.get(key) || { paid: 0, rate };
    if (rate === undefined) {
      student.state = "unavailable";
    } else {
      student.rate = rate;
      student.paid = Math.min(
        rate,
        student.paid + getTuitionPaymentAmount(record, rate),
      );
      student.state = student.paid >= rate ? "complete" : student.paid > 0 ? "partial" : "unpaid";
    }
    students.set(key, student);
  });
  return students;
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

function AuthPage({ onAuthenticated, onAuthFlowStarted, onAuthFlowFinished, onAccountCreated, onSignedIn, onAccessRenewed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [verificationUser, setVerificationUser] = useState(null);
  const [loginOtpUser, setLoginOtpUser] = useState(null);

  async function requestAccess() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/request-access", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result.error, "Could not submit an access request."));
      setOtpRequested(true);
      setMessage(result.message || "Your access request was submitted. An administrator must approve it before a code is sent.");
    } catch (requestError) {
      setError(requestError.message || "Could not submit an access request.");
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
        if (!otpRequested) {
          await requestAccess();
          return;
        }
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
          await onAuthenticated(credential.user);
          onAccessRenewed();
        } else {
          setLoginOtpUser(credential.user);
        }
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
          await credential.user.reload();
          await credential.user.getIdToken(true);
          if (mode === "signup") onAccountCreated();
          else onAccessRenewed();
          await onAuthenticated(credential.user);
        } else if (!credential.user.emailVerified) {
          setVerificationUser(credential.user);
        } else {
          setLoginOtpUser(credential.user);
        }
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
            <h2>{verificationUser ? "Verify your email" : loginOtpUser ? "Check your email" : mode === "login" ? "Welcome back" : otpRequested ? "Complete account setup" : "Request staff access"}</h2>
            <p>{verificationUser ? "An administrator must approve your access request before sending a one-time code." : loginOtpUser ? "Enter the one-time code sent to your email to finish signing in." : mode === "login" ? "Sign in with your school account, then verify with an email code." : otpRequested ? "Enter the code sent after an administrator approved your request." : "Request staff access. An administrator will review your request before sending a code."}</p>
          </div>
          {error && <div className="auth-message error-message" role="alert">{error}</div>}
          {message && <div className="auth-message success-message" role="status">{message}</div>}
          {verificationUser ? (
            <OtpVerificationForm
              user={verificationUser}
              onVerified={onAuthenticated}
              onBack={() => { setVerificationUser(null); setMessage(""); setMode("login"); }}
            />
          ) : loginOtpUser ? (
            <LoginOtpForm
              user={loginOtpUser}
              onVerified={async (verifiedUser) => {
                await onAuthenticated(verifiedUser);
                onSignedIn();
              }}
              onBack={async () => {
                await signOut(auth);
                setLoginOtpUser(null);
                setOtpCode("");
                setError("");
                setMessage("");
              }}
            />
          ) : (
            <>
              <div className="auth-tabs" role="tablist" aria-label="Account access">
                <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(""); setMessage(""); }}>Sign in</button>
                <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : ""} onClick={() => { setMode("signup"); setError(""); setMessage(""); }}>Request access</button>
              </div>
              <form className="auth-form" onSubmit={submit}>
                {mode === "signup" && !otpRequested && <>
                          <label htmlFor="signup-name">Full name</label>
                          <input id="signup-name" autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
                        </>}
                <label htmlFor="auth-email">Work email</label>
                <input id="auth-email" type="email" autoComplete="email" required readOnly={mode === "signup" && otpRequested} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@school.com" />
                {(mode === "login" || otpRequested) && <>
                  <label htmlFor="auth-otp">{mode === "login" ? "Approved access code (if requested)" : "Email verification code"}</label>
                  <div className="otp-input-row">
                    <input id="auth-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required={mode === "signup"} value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder={mode === "login" ? "For a new or renewed approval" : "6-digit code"} />
                  </div>
                </>}
                {mode === "login" || otpRequested ? <>
                  <label htmlFor="auth-password">Password</label>
                  <input id="auth-password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : "Enter your password"} />
                </> : null}
                {mode === "login" && <button className="forgot-link" type="button" onClick={resetPassword}>Forgot password?</button>}
                <button className="primary-button full-width" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : mode === "login" ? "Sign in securely" : otpRequested ? "Create account" : "Submit access request"}
                </button>
              </form>
              {(mode === "login" || otpRequested) && <>
              <div className="auth-divider"><span>or</span></div>
              <button className="google-button" type="button" disabled={busy} onClick={continueWithGoogle}>
                <svg aria-hidden="true" viewBox="0 0 48 48" className="google-icon">
                  <path fill="#4285F4" d="M47.6 24.5c0-1.6-.1-3.1-.4-4.6H24v9h13.2c-.6 2.9-2.3 5.3-4.8 7l7.8 6c4.6-4.2 7.4-10.3 7.4-17.4Z" />
                  <path fill="#34A853" d="M24 48c6.5 0 12-2.1 16-5.8l-7.8-6c-2.1 1.4-4.8 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-8 6.2C6.5 42.6 14.6 48 24 48Z" />
                  <path fill="#FBBC05" d="M10.5 28.6a14.4 14.4 0 0 1 0-9.2l-8-6.2a24 24 0 0 0 0 21.6l8-6.2Z" />
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C35.9 2.4 30.5 0 24 0 14.6 0 6.5 5.4 2.5 13.2l8 6.2C12.4 13.7 17.7 9.5 24 9.5Z" />
                </svg>
                {busy ? "Connecting…" : "Continue with Google"}
              </button>
              </>}
              <p className="access-note">Staff access requires administrator approval. Approved requests receive a one-time email code valid for 7 days.</p>
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

function AccessRequestsPanel({ user }) {
  const [requests, setRequests] = useState([]);
  const [canManage, setCanManage] = useState(null);
  const [busyRequestId, setBusyRequestId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest("/api/auth/access-requests", user)
      .then((result) => {
        if (active) {
          setRequests(result.requests);
          setCanManage(true);
        }
      })
      .catch((requestError) => {
        if (!active) return;
        if (requestError.status === 403) {
          setCanManage(false);
        } else {
          setError(requestError.message);
        }
      });
    return () => { active = false; };
  }, [user]);
  if (!canManage) return error ? <p className="account-panel-error" role="alert">{error}</p> : null;

  async function updateRequest(id, action) {
    setBusyRequestId(id);
    setError("");
    try {
      await apiRequest("/api/auth/access-requests", user, {
        method: "PATCH",
        body: JSON.stringify({ id, action }),
      });
      const result = await apiRequest("/api/auth/access-requests", user);
      setRequests(result.requests);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyRequestId("");
    }
  }

  return (
    <details className="account-panel access-requests-panel">
      <summary><BsPersonFillAdd aria-hidden="true" />Staff access requests ({requests.filter(({ status }) => status === "pending").length} pending)</summary>
      {error && <p className="account-panel-error" role="alert">{error}</p>}
      {requests.length ? <div className="access-request-list">
        {requests.map((request) => (
          <div className="access-request" key={request.id}>
            <div className="access-request-details">
              <strong>{request.name}</strong>
              <span>{request.email}</span>
              <small>Requested {request.createdAt ? new Date(request.createdAt).toLocaleString() : "recently"}</small>
              {request.expiresAt && <small>Code expires {new Date(request.expiresAt).toLocaleString()}</small>}
            </div>
            <div className="access-request-actions">
              <span className={`access-request-status status-${request.status.replace(/_/g, "-")}`}>{request.status.replace(/_/g, " ")}</span>
              {request.status === "pending" && <>
                <button className="apply-filters" type="button" disabled={Boolean(busyRequestId)} onClick={() => updateRequest(request.id, "approve")}>
                  {busyRequestId === request.id ? "Updating…" : "Approve"}
                </button>
                <button className="clear-filter" type="button" disabled={Boolean(busyRequestId)} onClick={() => updateRequest(request.id, "reject")}>Reject</button>
              </>}
              {["approved", "code_sent", "sending_code"].includes(request.status) && (
                <button className="apply-filters" type="button" disabled={Boolean(busyRequestId)} onClick={() => updateRequest(request.id, "send-code")}>
                  {busyRequestId === request.id ? "Sending…" : request.status === "approved" ? "Send OTP" : request.status === "sending_code" ? "Retry OTP" : "Resend OTP"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div> : <p className="account-password-help">No access requests yet.</p>}
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
    <details className="account-panel account-password-panel">
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
  const [activeTab, setActiveTab] = useState("overview");
  const [records, setRecords] = useState([]);
  const [exportingTuition, setExportingTuition] = useState(false);
  const [tuitionExportError, setTuitionExportError] = useState("");
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
  const [accessError, setAccessError] = useState("");
  const [accessExpiresAt, setAccessExpiresAt] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const expiryHandled = useRef(false);
  const onAccessExpiredRef = useRef(onAccessExpired);
  onAccessExpiredRef.current = onAccessExpired;

  useEffect(() => {
    let active = true;
    apiRequest("/api/auth/my-access", user)
      .then((result) => {
        if (active) {
          setIsAdmin(result.isAdmin === true);
          if (typeof result.expiresAt === "string") setAccessExpiresAt(result.expiresAt);
        }
      })
      .catch((lookupError) => {
        if (active) setAccessError(lookupError.message);
      });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!accessExpiresAt || expiryHandled.current) return undefined;
    const remaining = new Date(accessExpiresAt).getTime() - Date.now();
    function checkExpiry() {
      if (Date.now() < new Date(accessExpiresAt).getTime() || expiryHandled.current) return;
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
  }, [accessExpiresAt]);

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

  const tuitionStatuses = useMemo(() => buildTuitionStatuses(records), [records]);

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

  const visibleRecords = useMemo(() => {
    const categoryMatches = matchingRecords.filter((record) => {
      if (!appliedFilters.category) return true;
      if (appliedFilters.category === "outstanding") return isOutstanding(record);
      return displayValue(record.itemsSummary).toLocaleLowerCase().includes(appliedFilters.category);
    });
    return appliedFilters.class
      ? categoryMatches
      : sortRecordsByClass(categoryMatches, categoryClassKey);
  }, [matchingRecords, appliedFilters.category, appliedFilters.class]);

  const tuitionCounts = useMemo(() => {
    const visibleStudents = new Map();
    visibleRecords.forEach((record) => {
      const key = tuitionStudentKey(record, categoryClassKey);
      if (key) visibleStudents.set(key, tuitionStatuses.get(key)?.state || "unavailable");
    });
    const counts = { complete: 0, incomplete: 0, unavailable: 0 };
    visibleStudents.forEach((state) => {
      if (state === "complete") counts.complete += 1;
      else if (state === "partial" || state === "unpaid") counts.incomplete += 1;
      else counts.unavailable += 1;
    });
    return counts;
  }, [visibleRecords, tuitionStatuses]);

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

  async function exportTuitionWorkbook() {
    setExportingTuition(true);
    setTuitionExportError("");
    try {
      const sheets = createTuitionExportSheets(visibleRecords, tuitionStatuses, categoryClassKey);
      if (sheets.paid.length + sheets.notPaid.length === 0) {
        throw new Error("No students in the current results can be exported.");
      }
      const workbook = await createTuitionWorkbook(sheets);
      const blob = new Blob([workbook], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const start = fromMonth || "all";
      const end = toMonth || "all";
      link.href = url;
      link.download = `peacefield-tuition-status-${start}-to-${end}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (exportError) {
      setTuitionExportError(getErrorMessage(exportError, "Could not create the tuition Excel workbook."));
    } finally {
      setExportingTuition(false);
    }
  }

  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;

  function handleTabKeyDown(event, currentIndex) {
    let nextIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % dashboardTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + dashboardTabs.length) % dashboardTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = dashboardTabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = dashboardTabs[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(`dashboard-tab-${nextTab.id}`)?.focus();
  }

  return (
    <main className="page-shell" id="page-top">
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
          {accessExpiresAt && <span className="access-countdown" title="Account access ends when this approved access code expires. Submit another access request to renew access.">{formatAccessCountdown(accessExpiresAt, clock)}</span>}
          {accessError && <span className="access-countdown-error" role="alert">{accessError}</span>}
          <a className="make-payment-button" href="https://peacefieldpayments.com.ng" target="_blank" rel="noopener noreferrer">Make payment</a>
          <button className="signout-button" type="button" onClick={onSignOut}><FaSignOutAlt aria-hidden="true" />Sign out</button>
        </div>
      </header>

      <div className="dashboard-tabs" role="tablist" aria-label="Main dashboard navigation">
        {dashboardTabs.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            id={`dashboard-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls="dashboard-panel"
            tabIndex={activeTab === id ? 0 : -1}
            onClick={() => setActiveTab(id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            {id === "payments" && <span className="dashboard-tab-count">{visibleRecords.length}</span>}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <section className="dashboard-tab-panel" id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`} tabIndex={0}>
        <div className="dashboard-welcome">
          <span className="eyebrow">PEACEFIELD · STAFF PORTAL</span>
          <h2>Welcome to your dashboard</h2>
          <p>Choose a section to review tuition, find a payment, or manage account access.</p>
        </div>
        <section className="results-summary" aria-label="Summary of matching payment records" aria-live="polite">
          <div><span className="summary-label">Matching payments</span><strong>{new Intl.NumberFormat().format(visibleRecords.length)}</strong></div>
          {isAdmin && <div><span className="summary-label">Total amount</span><strong>{formatAmount(visibleRecords.reduce((sum, record) => sum + (Number(record.total) || 0), 0))}</strong></div>}
        </section>
        <div className="dashboard-overview-grid">
          <button className="dashboard-overview-card" type="button" onClick={() => setActiveTab("tuition")}>
            <span className="dashboard-overview-icon"><FaBook aria-hidden="true" /></span>
            <span className="dashboard-overview-copy"><strong>Tuition status</strong><small>{tuitionCounts.complete} paid in full · {tuitionCounts.incomplete} not complete</small></span>
            <span className="dashboard-overview-action-icon"><TbHistory aria-hidden="true" /></span>
          </button>
          <button className="dashboard-overview-card" type="button" onClick={() => setActiveTab("payments")}>
            <span className="dashboard-overview-icon"><FaCreditCard aria-hidden="true" /></span>
            <span className="dashboard-overview-copy"><strong>Find a payment</strong><small>Search records and filter by class or date</small></span>
            <span className="dashboard-overview-action-icon"><FiSearch aria-hidden="true" /></span>
          </button>
          <button className="dashboard-overview-card" type="button" onClick={() => setActiveTab("account")}>
            <span className="dashboard-overview-icon"><FiSettings aria-hidden="true" /></span>
            <span className="dashboard-overview-copy"><strong>Account tools</strong><small>Access requests and sign-in settings</small></span>
            <span className="dashboard-overview-action-icon"><RiAccountCircleFill aria-hidden="true" /></span>
          </button>
        </div>
      </section>}

      {activeTab === "account" && <section className="dashboard-tab-panel" id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`} tabIndex={0}>
        <div className="dashboard-section-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Account tools</h2></div><p>Manage staff access requests and sign-in options.</p></div>
        <div className="account-panels">
          <AccessRequestsPanel user={user} />
          <PasswordLinkPanel user={user} />
        </div>
      </section>}

      {activeTab === "payments" && <section className="dashboard-tab-panel" id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`} tabIndex={0}>
      <div className="dashboard-section-heading"><div><span className="eyebrow">PAYMENT RECORDS</span><h2>Find a payment</h2></div><p>Search transactions or narrow results by date, class, student, and fee.</p></div>
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
        {isAdmin && <div><span className="summary-label">Total amount</span><strong>{formatAmount(visibleRecords.reduce((sum, record) => sum + (Number(record.total) || 0), 0))}</strong></div>}
      </section>

      {isAdmin && <section className="category-totals" aria-label="Payment totals by category" aria-live="polite">
        <h2>Payment totals by category</h2>
        <div className="category-total-grid">
          <SummaryCard label="All matching" value={categoryTotals.all} />
          <SummaryCard label="Tuition payments" value={categoryTotals.tuition} />
          <SummaryCard label="Lesson payments" value={categoryTotals.lesson} />
          <SummaryCard label="Social payments" value={categoryTotals.social} />
          <SummaryCard label="Outstanding balance" value={categoryTotals.outstanding} detail={`${categoryTotals.outstandingCount} payments`} />
        </div>
        <p>Fee totals use the supplied class fee schedule and only count fees listed in the item summary. Day Care uses the Reception rate. Outstanding balances are shown separately.</p>
      </section>}

      <section className="table-card" id="payment-records" aria-label="Payment records">
        <div className="table-scroll"><table><thead><tr>{columns.map(([field, label]) => <th key={field} scope="col" className={field === "total" ? "numeric" : ""}>{label}</th>)}</tr></thead>
          <tbody>{visibleRecords.length ? visibleRecords.map((record, index) => <tr key={`${record.transactionId || record.paystackReference || "payment"}-${index}`}>
            {columns.map(([field]) => <td key={field} className={`${field === "timestamp" ? "date-cell" : ""}${field === "total" ? " numeric" : ""}`}>
              {field === "timestamp"
                ? formatDate(record[field])
                : field === "studentName"
                  ? <div className="student-name-cell">
                    <span className="student-name-value">{displayValue(record[field])}</span>
                    <TuitionStatusBadge
                      record={record}
                      status={tuitionStatuses.get(tuitionStudentKey(record, categoryClassKey))}
                      isLoading={loading}
                    />
                  </div>
                  : displayValue(record[field])}
            </td>)}
          </tr>) : <tr><td colSpan={columns.length} className="empty-state">{error || (loading ? "Loading payment records…" : records.length ? "No records match your search or filters." : "No payment records found.")}</td></tr>}</tbody>
        </table></div>
        <div className="table-footer"><div className="table-status"><span id="status-message" data-state={error ? "error" : "info"} role="status">{error || status}</span></div></div>
      </section>
      </section>}

      {activeTab === "tuition" && <section className="dashboard-tab-panel" id="dashboard-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`} tabIndex={0}>
        <div className="dashboard-section-heading"><div><span className="eyebrow">2026/27 SESSION</span><h2>Tuition overview</h2></div><p>Review tuition progress and export a filtered student list.</p></div>
        <section className="tuition-status-panel" aria-label="2026/27 tuition payment status">
          <div className="tuition-status-heading">
            <div><span className="eyebrow">SESSION SUMMARY</span><h2>Tuition status</h2></div>
            <div className="tuition-status-actions">
              <p>Tuition payments are calculated within the selected dates; active filters limit the students counted.</p>
              <button className="export-excel-button" type="button" onClick={exportTuitionWorkbook} disabled={loading || exportingTuition || visibleRecords.length === 0}>
                <FaFileExcel aria-hidden="true" />
                {exportingTuition ? "Preparing workbook…" : "Export Excel"}
              </button>
            </div>
          </div>
          {loading ? (
            <p className="tuition-status-message" role="status">Updating tuition status…</p>
          ) : error && records.length === 0 ? (
            <p className="tuition-status-message" role="status">Tuition status is unavailable because payment records could not be loaded.</p>
          ) : (
            <div className="tuition-status-grid">
              <div className="tuition-status-total tuition-status-total-complete"><span>Paid in full</span><strong>{tuitionCounts.complete}</strong><small>students</small></div>
              <div className="tuition-status-total tuition-status-total-incomplete"><span>Not complete</span><strong>{tuitionCounts.incomplete}</strong><small>students</small></div>
              <div className="tuition-status-total tuition-status-total-unavailable"><span>Needs review</span><strong>{tuitionCounts.unavailable}</strong><small>students</small></div>
            </div>
          )}
          {tuitionExportError && <p className="tuition-export-error" role="alert">{tuitionExportError}</p>}
          <p className="tuition-status-note">A payment counts toward tuition when its item summary lists “Tuition fee.” Its total is credited up to the class tuition price, so smaller payments count as partial. The payment type label does not determine tuition status.</p>
        </section>
        {isAdmin && <section className="category-totals" aria-label="Payment totals by category" aria-live="polite">
          <h2>Payment totals by category</h2>
          <div className="category-total-grid">
            <SummaryCard label="Tuition payments" value={categoryTotals.tuition} />
            <SummaryCard label="Lesson payments" value={categoryTotals.lesson} />
            <SummaryCard label="Social payments" value={categoryTotals.social} />
            <SummaryCard label="Outstanding balance" value={categoryTotals.outstanding} detail={`${categoryTotals.outstandingCount} payments`} />
          </div>
          <p>Fee totals use the supplied class fee schedule and only count fees listed in the item summary. Day Care uses the Reception rate. Outstanding balances are shown separately.</p>
        </section>}
      </section>}

      <footer className="page-footer" id="page-bottom"><span>Read-only · Data is loaded directly from Firestore</span><span>Search and filters apply to all loaded records</span></footer>
      <nav className="page-scroll-controls" aria-label="Page navigation">
        <button type="button" aria-label="Go to top" title="Go to top" onClick={() => window.scrollTo(0, 0)}>
          <FaArrowUp aria-hidden="true" />
          <span>Top</span>
        </button>
        <button type="button" aria-label="Go to bottom" title="Go to bottom" onClick={() => window.scrollTo(0, document.documentElement.scrollHeight)}>
          <FaArrowDown aria-hidden="true" />
          <span>Bottom</span>
        </button>
      </nav>
    </main>
  );
}

function SummaryCard({ label, value, detail }) {
  return <div className="category-total"><span className="summary-label">{label}</span><strong>{formatAmount(value)}</strong>{detail && <span className="summary-label">{detail}</span>}</div>;
}

function TuitionStatusBadge({ record, status, isLoading }) {
  const state = isLoading ? "loading" : status?.state || "unavailable";
  const labels = {
    complete: "Tuition complete",
    partial: "Tuition partial",
    unpaid: "Tuition unpaid",
    unavailable: "Status unavailable",
    loading: "Checking status…",
  };
  const detail = status?.rate
    ? `${formatAmount(status.paid)} / ${formatAmount(status.rate)}`
    : "";
  const title = status?.rate
    ? `${labels[state]} for ${record.class}: ${detail} naira paid for 2026/27.`
    : labels[state];

  return <span className="tuition-status-cell">
    <span className={`tuition-badge tuition-badge-${state}`} title={title}>{labels[state]}</span>
    {detail && <small className="tuition-status-detail">₦{detail}</small>}
  </span>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState(isFirebaseConfigured ? "loading" : "not-configured");
  const [authError, setAuthError] = useState("");
  const [verificationUser, setVerificationUser] = useState(null);
  const [notification, setNotification] = useState(null);
  const authFlowInProgress = useRef(false);
  const notificationId = useRef(0);

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
    let clearError = null;
    try {
      if (auth.currentUser) {
        await apiRequest("/api/auth/clear-login-otp", auth.currentUser, {
          method: "POST",
          body: JSON.stringify({}),
        });
      }
    } catch (error) {
      clearError = error;
    }

    try {
      await signOut(auth);
      showNotification(clearError
        ? `Signed out, but the verified session could not be cleared (${getErrorMessage(clearError, "server error")}). It will expire automatically.`
        : "Signed out successfully.", clearError ? "error" : "success");
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
        const tokenResult = await firebaseUser.getIdTokenResult();
        const otpAuthenticatedUntil = Number(tokenResult.claims.otpAuthenticatedUntil);
        const otpAuthenticatedAuthTime = Number(tokenResult.claims.otpAuthenticatedAuthTime);
        const authTime = Number(tokenResult.claims.auth_time);
        if (
          !Number.isInteger(otpAuthenticatedUntil) ||
          otpAuthenticatedUntil <= Math.floor(Date.now() / 1000) ||
          !Number.isInteger(otpAuthenticatedAuthTime) ||
          otpAuthenticatedAuthTime !== authTime
        ) {
          setVerificationUser(firebaseUser);
          setAuthStatus("otp-required");
          return;
        }
        await activateUser(firebaseUser);
      } catch (error) {
        setAuthError(error.message);
        setAuthStatus(error.status === 401 || error.status === 403 ? "access-denied" : "server-error");
      }
    });
  }, []);

  useEffect(() => {
    if (authStatus !== "active" || !user) return undefined;
    let timeout;
    user.getIdTokenResult().then((tokenResult) => {
      const otpAuthenticatedUntil = Number(tokenResult.claims.otpAuthenticatedUntil);
      const otpAuthenticatedAuthTime = Number(tokenResult.claims.otpAuthenticatedAuthTime);
      const authTime = Number(tokenResult.claims.auth_time);
      const remaining = otpAuthenticatedUntil * 1000 - Date.now();
      if (
        !Number.isInteger(otpAuthenticatedUntil) ||
        remaining <= 0 ||
        !Number.isInteger(otpAuthenticatedAuthTime) ||
        otpAuthenticatedAuthTime !== authTime
      ) {
        setVerificationUser(user);
        setAuthStatus("otp-required");
        return;
      }
      timeout = window.setTimeout(() => {
        setVerificationUser(user);
        setAuthStatus("otp-required");
      }, remaining);
    }).catch((error) => {
      setAuthError(error.message || "Could not verify the sign-in session.");
      setAuthStatus("server-error");
    });
    return () => window.clearTimeout(timeout);
  }, [authStatus, user]);

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
            setAuthError("Access to this account has expired. Submit a new access request and enter the code after an administrator approves it.");
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
  if (authStatus === "otp-required" && verificationUser) {
    return <LoginOtpPage user={verificationUser} onSignOut={signOutUser} onVerified={activateUser} />;
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
        onAccountCreated={() => showNotification("Account created and email verified successfully.")}
        onSignedIn={() => showNotification("Signed in successfully.")}
        onAccessRenewed={() => showNotification("Access code accepted. Account access has been renewed.")}
      />
      {notification && <AuthToast key={notification.id} message={notification.message} type={notification.type} />}
    </>
  );
}

function LoginOtpPage({ user, onSignOut, onVerified }) {
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">SIGN-IN VERIFICATION</p><h2>Check your email</h2><p>Enter the one-time code sent to <strong>{user.email}</strong> to continue. Codes expire in 10 minutes.</p></div>
    <LoginOtpForm user={user} onVerified={onVerified} onBack={onSignOut} />
  </div></section></main>;
}

function AuthToast({ message, type }) {
  return (
    <div className={`auth-toast${type === "error" ? " is-error" : ""}`} role={type === "error" ? "alert" : "status"}>
      <IoCheckmarkDoneCircleOutline aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function LoginOtpForm({ user, onVerified, onBack }) {
  const [otpCode, setOtpCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest("/api/auth/request-login-code", user, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessage(result.message || "A sign-in code has been sent. It expires in 10 minutes.");
    } catch (requestError) {
      setError(getErrorMessage(requestError, "Could not send a sign-in code."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    requestCode();
  }, [user]);

  async function verifyCode(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/api/auth/verify-login-code", user, {
        method: "POST",
        body: JSON.stringify({ otpCode }),
      });
      await user.getIdToken(true);
      await onVerified(user);
    } catch (verificationError) {
      setError(getErrorMessage(verificationError, "Could not verify the sign-in code."));
    } finally {
      setBusy(false);
    }
  }

  async function goBack() {
    setBusy(true);
    setError("");
    try {
      await onBack();
    } catch (backError) {
      setError(getErrorMessage(backError, "Could not return to sign in."));
    } finally {
      setBusy(false);
    }
  }

  return <>
    {message && <div className="auth-message success-message" role="status">{message}</div>}
    {error && <div className="auth-message error-message" role="alert">{error}</div>}
    <form className="auth-form" onSubmit={verifyCode}>
      <label htmlFor="login-otp">Sign-in code</label>
      <input id="login-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
      <button className="primary-button full-width" type="submit" disabled={busy || !/^\d{6}$/.test(otpCode)}>
        {busy ? "Verifying…" : "Verify and sign in"}
      </button>
    </form>
    <button className="text-button" type="button" disabled={busy} onClick={requestCode}>Resend code</button>
    <button className="text-button" type="button" disabled={busy} onClick={goBack}>Return to sign in</button>
  </>;
}

function OtpVerificationForm({ user, onVerified, onBack, onSignOut }) {
  const [name, setName] = useState(user.displayName || "");
  const [otpCode, setOtpCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestAccess() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/request-access", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: user.email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result.error, "Could not submit an access request."));
      setMessage(result.message || "Your request was submitted. An administrator must approve it before a code is sent.");
    } catch (requestError) {
      setError(requestError.message || "Could not submit an access request.");
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
    <label htmlFor="verification-name">Full name</label>
    <input id="verification-name" autoComplete="name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
    <button className="clear-filter" type="button" disabled={busy || !name.trim()} onClick={requestAccess}>
      {busy ? "Submitting…" : "Submit access request"}
    </button>
    <form className="auth-form" onSubmit={verifyCode}>
      <label htmlFor="verification-otp">Email verification code</label>
      <div className="otp-input-row">
        <input id="verification-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" />
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
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">ONE MORE STEP</p><h2>Verify your email</h2><p>Your email address <strong>{user.email}</strong> isn’t verified yet. Submit an access request; an administrator must approve it and send a code before you can continue.</p></div>
    <OtpVerificationForm user={user} onVerified={onVerified} onSignOut={onSignOut} />
  </div></section></main>;
}

function AccessDeniedPage({ error, onSignOut, serverError = false }) {
  const accessExpired = /access to this account has expired/i.test(error);
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">{serverError ? "SERVER ERROR" : "ACCESS NOT APPROVED"}</p><h2>{accessExpired ? "Your access has expired" : "We couldn’t verify access"}</h2><p>{error}</p><p>{serverError ? "This is a server configuration or temporary service problem, not an approval decision. Contact an administrator and try again after it is resolved." : accessExpired ? "Submit another access request. An administrator must approve it and send you a new code before access can be restored." : "Submit an access request or contact an administrator if this continues."}</p></div>
    <button className="primary-button full-width" onClick={onSignOut}><FaSignOutAlt aria-hidden="true" />Sign out</button>
  </div></section></main>;
}

function SetupPage() {
  return <main className="auth-page single-auth-page"><section className="auth-form-panel"><div className="auth-card">
    <Brand compact /><div className="auth-card-heading"><p className="eyebrow">SETUP REQUIRED</p><h2>Connect Firebase Authentication</h2><p>Add the Firebase web app settings to the Vercel environment variables before using the secure staff portal.</p></div>
    <div className="setup-list"><code>VITE_FIREBASE_API_KEY</code><code>VITE_FIREBASE_AUTH_DOMAIN</code><code>VITE_FIREBASE_PROJECT_ID</code><code>VITE_FIREBASE_APP_ID</code></div>
  </div></section></main>;
}
