/**
 * Discord embed size limits — see
 * https://discord.com/developers/docs/resources/channel#embed-limits
 */
const LIMITS = {
    title: 256,
    description: 4096,
    fieldName: 256,
    fieldValue: 1024,
    footerText: 2048,
    authorName: 256,
    totalChars: 6000,
    fieldsCount: 25,
    embedsPerMessage: 10,
};

const ELLIPSIS = '…';

/**
 * Hard-truncate a string with an ellipsis suffix if it exceeds limit.
 * Returns the original string unchanged when it fits.
 */
function truncate(text, limit) {
    if (text == null) return '';
    const s = String(text);
    if (s.length <= limit) return s;
    return s.slice(0, Math.max(0, limit - ELLIPSIS.length)) + ELLIPSIS;
}

function safeTitle(s)       { return truncate(s, LIMITS.title); }
function safeDescription(s) { return truncate(s, LIMITS.description); }
function safeFieldName(s)   { return truncate(s, LIMITS.fieldName); }
function safeFieldValue(s)  { return truncate(s, LIMITS.fieldValue); }
function safeFooter(s)      { return truncate(s, LIMITS.footerText); }

/**
 * Apply per-field clamps to an array of `{ name, value, inline }` field objects.
 * Drops anything past the 25-field hard limit.
 */
function safeFields(fields) {
    if (!Array.isArray(fields)) return [];
    return fields.slice(0, LIMITS.fieldsCount).map(f => ({
        name: safeFieldName(f.name || '​'),
        value: safeFieldValue(f.value || '​'),
        inline: !!f.inline,
    }));
}

/**
 * Compute the total character count of an embed-like object (title + desc +
 * footer + author + each field name/value). Used to enforce the 6000-char cap.
 */
function embedCharCount(embed) {
    let n = 0;
    if (embed.title) n += String(embed.title).length;
    if (embed.description) n += String(embed.description).length;
    if (embed.footer?.text) n += String(embed.footer.text).length;
    if (embed.author?.name) n += String(embed.author.name).length;
    if (Array.isArray(embed.fields)) {
        for (const f of embed.fields) {
            if (f.name) n += String(f.name).length;
            if (f.value) n += String(f.value).length;
        }
    }
    return n;
}

/**
 * If the total embed exceeds 6000 chars, progressively trim the description
 * then drop trailing fields until it fits. Operates on a plain JSON-ish embed
 * shape (not an EmbedBuilder instance) — use `.toJSON()` first if needed.
 */
function enforceTotalLimit(embed) {
    const e = { ...embed, fields: [...(embed.fields || [])] };
    let total = embedCharCount(e);
    if (total <= LIMITS.totalChars) return e;

    // First: aggressively trim description if oversized.
    if (e.description && e.description.length > 500) {
        const overshoot = total - LIMITS.totalChars;
        const newLen = Math.max(500, e.description.length - overshoot - ELLIPSIS.length);
        e.description = truncate(e.description, newLen);
        total = embedCharCount(e);
        if (total <= LIMITS.totalChars) return e;
    }

    // Then: drop trailing fields until we fit.
    while (e.fields.length > 0 && total > LIMITS.totalChars) {
        e.fields.pop();
        total = embedCharCount(e);
    }
    return e;
}

module.exports = {
    LIMITS,
    truncate,
    safeTitle, safeDescription, safeFieldName, safeFieldValue, safeFooter,
    safeFields,
    embedCharCount,
    enforceTotalLimit,
};
