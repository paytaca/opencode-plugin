"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYMENT_SUCCESS_LINE = exports.PROXY_MARKER = void 0;
exports.filterProxyChatter = filterProxyChatter;
// Zero-width marker the proxy prepends to every synthetic message it streams
// (tier-selection prompts, credits/plans output, payment notices). The
// messages stay visible in the opencode UI — zero-width characters don't
// render — but carrying the marker lets this plugin strip them from the
// context passed to the LLM, since proxy/payment chatter is not relevant to
// the coding session.
exports.PROXY_MARKER = String.fromCharCode(0x200b, 0x200b, 0x200b, 0x200b);
// The success line the proxy prepends to a real model response after a
// payment completes. Useful during streaming UX, but it is proxy chatter —
// stripped from assistant text before the LLM sees it.
exports.PAYMENT_SUCCESS_LINE = '💳 Payment successful — generating your response...';
// Replies that are part of a proxy interactive flow (tier pick, approval,
// credits/plans shortcuts). Only removed when they immediately follow a
// marked proxy message, so genuine user messages are never dropped.
const SELECTION_RE = /^\s*(?:\d{1,3}|yes|no|credits|plans|balance)\s*$/i;
function stripSystemReminders(text) {
    let r = text || '';
    const open = '<system-reminder>';
    const close = '</system-reminder>';
    let i = r.indexOf(open);
    while (i !== -1) {
        const j = r.indexOf(close, i);
        if (j === -1)
            break;
        r = r.substring(0, i) + r.substring(j + close.length);
        i = r.indexOf(open);
    }
    return r;
}
function textOf(msg) {
    const parts = msg && msg.parts;
    if (!Array.isArray(parts))
        return '';
    let out = '';
    for (const part of parts) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
            out += part.text;
        }
    }
    return out;
}
function isMarkedProxyMessage(msg) {
    return !!(msg && msg.info && msg.info.role === 'assistant' && textOf(msg).indexOf(exports.PROXY_MARKER) !== -1);
}
function isSelectionReply(msg) {
    if (!msg || !msg.info || msg.info.role !== 'user')
        return false;
    return SELECTION_RE.test(stripSystemReminders(textOf(msg)).trim());
}
// Remove the payment-success preamble from an assistant message without
// mutating opencode's stored objects — returns a shallow-cloned wrapper when
// a change is made, or null when the message is clean.
function withoutPaymentSuccessLine(msg) {
    const parts = msg && msg.parts;
    if (!Array.isArray(parts))
        return null;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.indexOf(exports.PAYMENT_SUCCESS_LINE) !== -1) {
            const cleaned = part.text.split(exports.PAYMENT_SUCCESS_LINE).join('').replace(/\n{3,}/g, '\n\n');
            const newParts = parts.slice();
            newParts[i] = { ...part, text: cleaned };
            return { ...msg, parts: newParts };
        }
    }
    return null;
}
// Drop proxy-generated assistant messages (and the interactive selection
// replies directly following them) from the LLM context. The final message —
// the turn currently being answered — is always kept, so the proxy can still
// detect tier selections and approval replies in the live request.
function filterProxyChatter(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return messages;
    const kept = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const isLast = i === messages.length - 1;
        if (!isLast && isMarkedProxyMessage(msg)) {
            const next = messages[i + 1];
            if (next && (i + 1) < messages.length - 1 && isSelectionReply(next)) {
                i++;
            }
            continue;
        }
        if (msg && msg.info && msg.info.role === 'assistant') {
            const cleaned = withoutPaymentSuccessLine(msg);
            kept.push(cleaned || msg);
            continue;
        }
        kept.push(msg);
    }
    return kept;
}
//# sourceMappingURL=context.js.map