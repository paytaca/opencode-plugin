"use strict";
// Credits → TUI toast notifications.
//
// Watches remaining Paytaca AI time credits and nudges the user through TUI
// toasts: a warning when credits run low or are exhausted, and a success toast
// when more credits appear (manual buy or auto-refill). Purely advisory — every
// toast call is wrapped so a failure (headless session, no TUI attached) can
// never break a session.
//
// Disable entirely by setting PAYTACA_CREDITS_TOASTS=0.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCreditsToastWatch = createCreditsToastWatch;
const ENABLED = process.env.PAYTACA_CREDITS_TOASTS !== '0';
const MIN_INTERVAL_MS = 60000; // at most one backend poll per minute
const REFILL_DELTA_S = 60; // remaining grew by >= this ⇒ treat as a refill
const TOAST_DURATION_MS = 9000;
// Buckets of remaining time. Higher band = more time. Bands 0-2 are "low" and
// produce a toast when crossed downward; 3-4 are healthy and stay quiet.
const bandForSeconds = (s) => {
    if (s <= 0)
        return 0; // exhausted
    if (s < 120)
        return 1; // < 2 min
    if (s < 600)
        return 2; // < 10 min
    if (s < 1800)
        return 3; // < 30 min
    return 4; // >= 30 min
};
const formatShort = (seconds) => {
    if (seconds >= 3600) {
        return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
    }
    return `${Math.max(1, Math.round(seconds / 60))}m`;
};
function createCreditsToastWatch(deps) {
    let lastRemaining = NaN;
    let lastBand = NaN;
    let lastCheckAt = 0;
    const push = (title, message, variant) => {
        try {
            const tui = deps.client?.tui;
            if (!tui || typeof tui.showToast !== 'function') {
                return;
            }
            const result = tui.showToast({
                body: { title, message, variant, duration: TOAST_DURATION_MS },
            });
            result?.catch?.(() => { });
        }
        catch {
            // Never throw into a session.
        }
    };
    const emitBand = (band, remaining, name) => {
        if (band === 0) {
            push('⛔ Paytaca credits exhausted', `${name} is out of time. The next request will ask you to buy a plan (or arm auto-refill).`, 'error');
        }
        else if (band === 1) {
            push('🛑 Paytaca credits almost gone', `${name}: under ${formatShort(120)} left — buy a plan soon or arm auto-refill.`, 'error');
        }
        else if (band === 2) {
            push('⏳ Paytaca credits running low', `${name}: about ${formatShort(remaining)} remaining.`, 'warning');
        }
    };
    const check = async () => {
        if (!ENABLED)
            return;
        if (!deps.client)
            return;
        const backendUrl = deps.backendUrl();
        const walletHash = deps.walletHash();
        if (!backendUrl || !walletHash)
            return;
        const now = Date.now();
        if (now - lastCheckAt < MIN_INTERVAL_MS)
            return;
        lastCheckAt = now;
        let sessions = [];
        try {
            const res = await fetch(`${backendUrl}/v1/wallet/status`, {
                headers: { 'X-Wallet-Hash': walletHash },
            });
            if (!res.ok)
                return;
            const data = await res.json();
            sessions = Array.isArray(data.sessions) ? data.sessions : [];
        }
        catch {
            return; // backend unreachable — nothing to toast about
        }
        // The session with the most remaining time is the one the user is most
        // likely actively using; report on it even when it's exhausted (so we can
        // name the model in the "out of time" toast).
        const tracked = sessions
            .filter((s) => Number.isFinite(Number(s.time_remaining_seconds)))
            .sort((a, b) => (Number(b.time_remaining_seconds) || 0) - (Number(a.time_remaining_seconds) || 0));
        const best = tracked[0];
        const remaining = best ? Number(best.time_remaining_seconds) || 0 : 0;
        const name = best ? best.display_name || best.ai_model || 'model' : '';
        const band = bandForSeconds(remaining);
        if (!isFinite(lastRemaining)) {
            // First read — only warn if already low, so a fresh session isn't noisy.
            if (band <= 2) {
                emitBand(band, remaining, name);
            }
        }
        else if (remaining > lastRemaining + REFILL_DELTA_S) {
            // New credits appeared — either a manual buy or an auto-refill.
            push('⚡ Paytaca credits added', `${name}: ${formatShort(remaining)} remaining now.`, 'success');
        }
        else if (band < lastBand || !isFinite(lastBand)) {
            emitBand(band, remaining, name);
        }
        lastRemaining = remaining;
        lastBand = band;
    };
    return { check };
}
//# sourceMappingURL=credits.js.map