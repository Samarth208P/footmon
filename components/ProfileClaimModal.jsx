"use client";

import { useState } from "react";

export default function ProfileClaimModal({ onClaim, onDismiss, error, busy, setError }) {
  const [input, setInput] = useState("");

  const validate = (v) => {
    if (v.length < 3 || v.length > 20) return "Username must be 3–20 characters";
    if (!/^[A-Za-z0-9_]+$/.test(v)) return "Only letters, numbers and underscores";
    return null;
  };

  const handleSubmit = () => {
    const err = validate(input.trim());
    if (err) { setError(err); return; }
    onClaim(input.trim());
  };

  return (
    <div className="profile-overlay" role="dialog" aria-modal="true">
      <div className="profile-modal">
        <h2 className="profile-modal-title">Choose your username</h2>
        <p className="profile-modal-sub">
          Other players see this instead of your wallet address. You can change it once every 30 days.
        </p>
        <label className="profile-modal-label" htmlFor="profileInput">Username</label>
        <input
          id="profileInput"
          className="profile-modal-input"
          type="text"
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. Pele10"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          disabled={busy}
        />
        <p className="profile-modal-hint">3–20 characters. Letters, numbers and underscores only.</p>
        {error && <p className="profile-modal-error" role="alert">{error}</p>}
        <button className="profile-modal-btn" onClick={handleSubmit} disabled={busy}>
          {busy ? "Waiting for signature…" : "Sign & claim"}
        </button>
        <button className="profile-modal-link" onClick={onDismiss} type="button">Not now</button>
        <p className="profile-modal-foot">Signing is free — no gas, no transaction.</p>
      </div>
    </div>
  );
}
