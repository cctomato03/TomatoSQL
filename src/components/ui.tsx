import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";

export function Modal({
  title,
  children,
  footer,
  onClose,
  size = "md",
  width,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: "sm" | "md" | "lg";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${size === "sm" ? "sm" : size === "lg" ? "lg" : ""}`}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        ref={ref}
      >
        <div className="dialog-head">
          <div className="dialog-title">{title}</div>
          <button className="dialog-close" onClick={onClose} title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  full,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`field ${full ? "full" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox" style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={`seg-item ${value === o.value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind === "ok" ? "ok" : t.kind === "err" ? "err" : ""}`}
          onClick={() => dismiss(t.id)}
          title="点击关闭"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({
  title,
  text,
  children,
}: {
  title?: string;
  text?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {title && <div className="empty-title">{title}</div>}
      {text && <div className="empty-text">{text}</div>}
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row" style={{ padding: "0.8rem", color: "var(--text-3)" }}>
      <div className="spinner" />
      <span>{label ?? "加载中…"}</span>
    </div>
  );
}

export interface MenuItemSpec {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onClick?: () => void;
  separator?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItemSpec[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 34 - 20),
  };

  return (
    <div className="menu" style={style} ref={ref}>
      {items.map((it, i) =>
        it.separator ? (
          <div className="menu-sep" key={`sep-${i}`} />
        ) : (
          <button
            key={it.label}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
