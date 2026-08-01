"use client";

export default function Toast({ toasts }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.type} toast--show`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
