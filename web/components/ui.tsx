"use client";

/*
 * FairHold UI primitives, styled per STYLES.md: monochrome grays, hairline borders, shadow-sm
 * cards, inverted gray-900/gray-100 primary actions, and hue only for status. The class
 * recipes live in lib/ui-classes.ts. Components follow shadcn/ui's API patterns (Button,
 * Card, Badge, Alert, AlertDialog, Skeleton, Tabs, Table) on native elements.
 */

import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { addressUrl, txUrl } from "@/lib/config";
import { fmtDuration, short } from "@/lib/format";
import {
  activePillClass,
  descriptionClass,
  destructiveButtonClass,
  errorBadgeClass,
  ghostButtonClass,
  inactivePillClass,
  infoBadgeClass,
  inputClass,
  labelClass,
  linkButtonClass,
  modalPanelClass,
  neutralBadgeClass,
  pageTitleClass,
  pillBaseClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  sectionTitleClass,
  skeletonClass,
  successBadgeClass,
  tableCellClass,
  tableHeadCellClass,
  tableRowClass,
  warningBadgeClass,
} from "@/lib/ui-classes";
import { IconAlert, IconCheck, IconCopy, IconExternal, IconInfo, IconX } from "./icons";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- button

type Variant = "primary" | "secondary" | "outline" | "danger" | "ghost" | "link" | "inverse";
type Size = "sm" | "md" | "lg" | "icon";

const BUTTON_VARIANT: Record<Variant, string> = {
  primary: primaryButtonClass,
  secondary: secondaryButtonClass,
  outline: secondaryButtonClass,
  danger: destructiveButtonClass,
  ghost: ghostButtonClass,
  link: linkButtonClass,
  // Used on inverted surfaces: always the opposite of the surface it sits on.
  inverse:
    "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 bg-white text-gray-900 hover:bg-gray-100 dark:bg-gray-900 dark:text-white dark:hover:bg-gray-800",
};
const BUTTON_SIZE: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cx(BUTTON_VARIANT[variant], BUTTON_SIZE[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  busy,
  busyLabel,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean; busyLabel?: string }) {
  return (
    <button type="button" {...rest} aria-busy={busy || undefined} disabled={rest.disabled || busy} className={buttonClass(variant, size, className)}>
      {busy && <Spinner />}
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent", className)} aria-hidden />;
}

// ---------------------------------------------------------------- layout

export function Card({
  title,
  description,
  children,
  className,
  action,
  tone = "default",
  id: sectionId,
}: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
  tone?: "default" | "highlight";
}) {
  const id = useId();
  return (
    <section
      id={sectionId}
      aria-labelledby={title ? (sectionId ? `${sectionId}-title` : id) : undefined}
      className={cx(sectionClass, "flex scroll-mt-24 flex-col gap-5 p-5 sm:p-6", tone === "highlight" && "border-gray-900 dark:border-gray-100", className)}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            {title && (
              <h2 id={sectionId ? `${sectionId}-title` : id} tabIndex={sectionId ? -1 : undefined} className={cx(sectionTitleClass, "outline-none")}>
                {title}
              </h2>
            )}
            {description && <p className={cx(descriptionClass, "mt-1")}>{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children !== undefined && children !== null && <div className="min-w-0">{children}</div>}
    </section>
  );
}

/**
 * Smoothly scrolls to a Card (by its `id`) and moves keyboard focus to its heading, so keyboard
 * and screen-reader users land where sighted users do.
 */
export function goToSection(sectionId: string) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  const target = document.getElementById(`${sectionId}-title`) ?? section;
  target.focus({ preventScroll: true });
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-1 text-sm">{eyebrow}</div>}
        <h1 className={pageTitleClass}>{title}</h1>
        {description && <p className={cx(descriptionClass, "mt-1 max-w-2xl")}>{description}</p>}
      </div>
      {actions && <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cx("h-px w-full shrink-0 bg-gray-200 dark:bg-gray-700", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx(skeletonClass, className)} aria-hidden />;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
      {icon && <div className="mb-4 rounded-full bg-gray-100 p-4 text-gray-400 dark:bg-gray-800 dark:text-gray-500">{icon}</div>}
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      {body && <p className={cx(descriptionClass, "mt-1 max-w-sm")}>{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- badge

export type Tone = "neutral" | "info" | "warn" | "danger" | "success" | "ai";

const TONE_BADGE: Record<Tone, string> = {
  neutral: neutralBadgeClass,
  info: infoBadgeClass,
  warn: warningBadgeClass,
  danger: errorBadgeClass,
  success: successBadgeClass,
  // Mediator/AI is not a status, so it stays monochrome.
  ai: neutralBadgeClass,
};

export function Badge({ tone = "neutral", children, dot = true, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", TONE_BADGE[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />}
      {children}
    </span>
  );
}

// Every status has a text label; colour is never the only signal.
export const STATUS_META: Record<number, { label: string; tone: Tone }> = {
  1: { label: "Awaiting payee", tone: "neutral" },
  2: { label: "Active", tone: "info" },
  3: { label: "In dispute", tone: "danger" },
  4: { label: "Proposal ready", tone: "warn" },
  5: { label: "Settled", tone: "success" },
  6: { label: "Refunded", tone: "neutral" },
};

export function StatusBadge({ status }: { status: number }) {
  const m = STATUS_META[status] ?? { label: "Unknown", tone: "neutral" as Tone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

// ---------------------------------------------------------------- tabs (filter pills)

export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
}) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full gap-2 overflow-x-auto">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cx(pillBaseClass, "inline-flex items-center gap-1.5 whitespace-nowrap", active ? activePillClass : inactivePillClass)}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cx("rounded-full px-1.5 text-xs tabular-nums", active ? "bg-white/20 dark:bg-gray-900/15" : "bg-gray-100 dark:bg-gray-700")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- forms

export const inputCls = inputClass;
export const labelCls = labelClass;

type FieldControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * Accessible field: real <label for>, hint and error wired through aria-describedby,
 * aria-invalid on error. Pass a single control element, or a render function for composites.
 */
export function Field({
  label,
  hint,
  error,
  success,
  children,
  optional,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  success?: ReactNode;
  optional?: boolean;
  children: ReactElement | ((p: FieldControlProps) => ReactNode);
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const describedBy = error || hint || success ? hintId : undefined;
  const controlProps: FieldControlProps = { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined };
  const control =
    typeof children === "function"
      ? children(controlProps)
      : isValidElement(children)
        ? cloneElement(children as ReactElement<FieldControlProps>, controlProps)
        : children;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className={cx(labelClass, "flex items-baseline justify-between gap-2")}>
        <span>{label}</span>
        {optional && <span className="text-xs font-normal text-gray-500 dark:text-gray-400">Optional</span>}
      </label>
      {control}
      {error ? (
        <p id={hintId} className="flex items-start gap-1 text-xs font-medium text-red-600 dark:text-red-400">
          <IconAlert size={13} className="mt-px shrink-0" /> {error}
        </p>
      ) : success ? (
        <p id={hintId} className="flex items-start gap-1 text-xs font-medium text-green-600 dark:text-green-400">
          <IconCheck size={13} className="mt-px shrink-0" /> {success}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- table

export const tableCls = {
  table: "w-full text-sm",
  head: tableHeadCellClass,
  row: tableRowClass,
  cell: tableCellClass,
};

// ---------------------------------------------------------------- data display

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-white"
      aria-label={copied ? "Copied" : `${label} ${value}`}
      title={copied ? "Copied" : label}
    >
      {copied ? <IconCheck size={13} className="text-green-600 dark:text-green-400" /> : <IconCopy size={13} />}
    </button>
  );
}

export function AddressLink({ address, you, copy = true }: { address: string; you?: boolean; copy?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <a
        href={addressUrl(address)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-sm font-medium text-gray-900 underline-offset-4 hover:underline dark:text-white"
        title={`${address} (opens explorer)`}
      >
        {short(address)}
      </a>
      {you && <span className="rounded-full bg-gray-900 px-1.5 text-[10px] font-medium uppercase tracking-wide text-white dark:bg-gray-100 dark:text-gray-900">You</span>}
      {copy && <CopyButton value={address} label="Copy address" />}
    </span>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs font-medium text-gray-900 underline-offset-4 hover:underline dark:text-white"
      title={`${hash} (opens explorer)`}
    >
      {label ?? short(hash)} <IconExternal size={12} className="text-gray-400 dark:text-gray-500" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Amount({ value, size = "md", className }: { value: string; size?: "sm" | "md" | "lg" | "xl"; className?: string }) {
  const sizes = { sm: "text-sm", md: "text-lg", lg: "text-2xl", xl: "text-3xl sm:text-4xl" };
  return (
    <span className={cx("font-bold tabular-nums tracking-tight text-gray-900 dark:text-white", sizes[size], className)}>
      {value}
      <span className="ml-1 text-[0.5em] font-medium tracking-normal text-gray-500 dark:text-gray-400">tUSD8</span>
    </span>
  );
}

/** Countdown against chain time (offsetMs = chainNow - localNow). */
export function Countdown({ deadline, offsetMs, done = "now" }: { deadline: bigint | number; offsetMs: number; done?: string }) {
  // Clock reads happen in effects only: the app is prerendered, and Date.now() during render is not allowed.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  if (now === null) return <span className="tabular-nums">…</span>;
  const remaining = Number(deadline) - (now + offsetMs) / 1000;
  return <span className="tabular-nums">{remaining <= 0 ? done : fmtDuration(remaining)}</span>;
}

export function useChainNow(offsetMs: number) {
  // Starts at 0 (before any deadline) until the first client tick; see Countdown.
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor((Date.now() + offsetMs) / 1000));
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [offsetMs]);
  return now;
}

/** Elapsed share of a time window. */
export function TimeBar({ start, end, now, className }: { start: number; end: number; now: number; className?: string; tone?: string }) {
  const span = Math.max(1, end - start);
  const pctDone = Math.min(100, Math.max(0, ((now - start) / span) * 100));
  return (
    <div
      className={cx("h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700", className)}
      role="progressbar"
      aria-label="Time elapsed in this phase"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pctDone)}
    >
      <div className="h-full rounded-full bg-gray-900 transition-[width] duration-1000 dark:bg-gray-100" style={{ width: `${pctDone}%` }} />
    </div>
  );
}

/** Alert / callout. Neutral info uses the gray callout; status tones use soft status colours. */
export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warn" | "error" | "success";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300",
    warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-300",
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300",
    success: "border-green-200 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-900/20 dark:text-green-300",
  };
  const titleTone = { info: "text-gray-900 dark:text-white", warn: "", error: "", success: "" }[tone];
  const iconTone = { info: "text-gray-500 dark:text-gray-400", warn: "", error: "", success: "" }[tone];
  const Icon = { info: IconInfo, warn: IconAlert, error: IconAlert, success: IconCheck }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-sm", styles[tone])}>
      <Icon className={cx("mt-0.5 shrink-0", iconTone)} />
      <div className="min-w-0 flex-1">
        {title && <p className={cx("font-semibold leading-snug", titleTone)}>{title}</p>}
        {children && <div className={cx("break-words", Boolean(title) && "mt-0.5", tone !== "info" && Boolean(title) && "opacity-90")}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Monochrome split: payee in near-black/near-white, payer in light gray. */
export function SplitBar({ payeeBps, payeeLabel = "Payee", payerLabel = "Payer" }: { payeeBps: number; payeeLabel?: string; payerLabel?: string }) {
  const payee = payeeBps / 100;
  const fmt = (v: number) => v.toFixed(v % 1 ? 1 : 0);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700" role="img" aria-label={`${payeeLabel} ${fmt(payee)} percent, ${payerLabel} ${fmt(100 - payee)} percent`}>
        <div className="bg-gray-900 transition-[width] dark:bg-gray-100" style={{ width: `${payee}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500 dark:text-gray-400" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gray-900 dark:bg-gray-100" />{payeeLabel} {fmt(payee)}%</span>
        <span className="inline-flex items-center gap-1.5">{payerLabel} {fmt(100 - payee)}%<span className="h-2 w-2 rounded-full bg-gray-200 dark:bg-gray-700" /></span>
      </div>
    </div>
  );
}

/** Multi-step progress list for wallet flows. */
export type StepState = "todo" | "active" | "done" | "error" | "skipped";
export function ProgressSteps({ steps }: { steps: { label: string; state: StepState; detail?: string }[] }) {
  return (
    <ol className="grid gap-3" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.label} className="flex items-start gap-3 text-sm" aria-current={s.state === "active" ? "step" : undefined}>
          <span
            className={cx(
              "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
              s.state === "done" && "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900",
              s.state === "active" && "border-gray-900 text-gray-900 dark:border-gray-100 dark:text-white",
              s.state === "error" && "border-red-600 bg-red-600 text-white",
              (s.state === "todo" || s.state === "skipped") && "border-gray-300 dark:border-gray-600",
            )}
          >
            {s.state === "done" ? <IconCheck size={12} /> : s.state === "active" ? <Spinner className="h-3 w-3 border-[1.5px]" /> : s.state === "error" ? <IconX size={12} /> : null}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className={cx("font-medium leading-snug", s.state === "todo" || s.state === "skipped" ? "text-gray-500 dark:text-gray-400" : "text-gray-900 dark:text-white", s.state === "skipped" && "line-through")}>
              {s.label}
            </span>
            {s.detail && <span className="text-xs text-gray-500 dark:text-gray-400">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- confirm dialog (AlertDialog)

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
}
const ConfirmCtx = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const v = useContext(ConfirmCtx);
  if (!v) throw new Error("useConfirm outside ConfirmProvider");
  return v;
}

/** Built on native <dialog>: modal focus trap, Esc to cancel, focus returns to the trigger. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      requestAnimationFrame(() => ref.current?.showModal());
    });
  }, []);

  const close = (v: boolean) => {
    ref.current?.close();
    resolver.current?.(v);
    resolver.current = null;
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onCancel={(e) => {
          e.preventDefault();
          close(false);
        }}
        className={cx(modalPanelClass, "m-auto w-[calc(100%-2rem)] p-0 text-gray-900 dark:text-white")}
      >
        {opts && (
          <div className="grid gap-5 p-6">
            <div className="grid gap-1.5">
              <h2 id={titleId} className={sectionTitleClass}>{opts.title}</h2>
              <div id={bodyId} className={descriptionClass}>{opts.body}</div>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => close(false)} autoFocus>Go back</Button>
              <Button variant={opts.tone === "danger" ? "danger" : "primary"} onClick={() => close(true)}>{opts.confirmLabel}</Button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------- hooks

/** Run `fn` now (async, next tick) and then every `ms`. */
export function usePoll(fn: () => unknown, ms: number) {
  useEffect(() => {
    const first = setTimeout(() => void fn(), 0);
    const t = setInterval(() => void fn(), ms);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [fn, ms]);
}
