/**
 * theme-guard.js — Lorenco Accounting Global Dark Theme Guard
 *
 * Purpose:
 *   Ensures every accounting page reliably operates in dark mode.
 *   Runs as early as possible (place <script> in <head>, before inline styles).
 *
 * What it does:
 *   1. Adds data-theme="dark" to <html> — enables CSS attribute selectors
 *   2. Injects css/dark-theme.css if the <link> is missing (safety net for new pages)
 *   3. Exposes a ThemeGuard API for optional per-page hooks
 *
 * Usage (new pages):
 *   <head>
 *     <script src="js/theme-guard.js"></script>   ← add BEFORE inline <style>
 *     ...
 *     <link rel="stylesheet" href="css/dark-theme.css">  ← still keep this too
 *   </head>
 *
 * The CSS link is still required for correct load order. theme-guard.js provides
 * the HTML attribute hook and a programmatic API — it does not replace the CSS.
 */

(function () {
    'use strict';

    // ── 1. Mark <html> with dark theme attribute immediately ──────────────────
    // This fires before any rendering, preventing flash of light content.
    document.documentElement.setAttribute('data-theme', 'dark');

    // ── 2. Ensure dark-theme.css is loaded ───────────────────────────────────
    // Safety net: if a new page is added without the <link>, inject it.
    function ensureDarkThemeCSS() {
        var existing = document.querySelector('link[href*="dark-theme.css"]');
        if (!existing) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            // Resolve relative path from current page location
            var base = (document.currentScript && document.currentScript.src)
                ? document.currentScript.src.replace(/js\/theme-guard\.js.*$/, '')
                : '';
            link.href = base + 'css/dark-theme.css';
            // Insert as last stylesheet so it wins the cascade
            document.addEventListener('DOMContentLoaded', function () {
                document.head.appendChild(link);
            });
        }
    }

    // ── 3. Surface component classes — applied to <body> on DOMContentLoaded ──
    // Adds .dark-theme-active to <body> so CSS can scope with .dark-theme-active
    // selectors as an alternative to !important rules in dark-theme.css.
    function applyBodyClass() {
        if (document.body) {
            document.body.classList.add('dark-theme-active');
        }
    }

    // ── 4. ThemeGuard public API ──────────────────────────────────────────────
    var _hooks = [];

    // Colour tokens — mirror :root vars in dark-theme.css so JS-driven
    // rendering (charts, dynamic rows) can use the same values without
    // reading computed styles at runtime.
    var TOKENS = Object.freeze({
        bgDark:        '#0f0c29',
        bgMid:         '#302b63',
        surface:       'rgba(255,255,255,0.06)',
        surfaceAlt:    'rgba(255,255,255,0.04)',
        surfaceHover:  'rgba(255,255,255,0.10)',
        border:        'rgba(255,255,255,0.08)',
        borderStrong:  'rgba(255,255,255,0.12)',
        text:          '#ffffff',
        textSecondary: 'rgba(255,255,255,0.7)',
        textMuted:     'rgba(255,255,255,0.5)',
        accent:        '#f59e0b',
        accentDark:    '#d97706',
        accentLight:   '#fbbf24',
        accentGlow:    'rgba(245,158,11,0.3)',
        positive:      '#34a853',
        negative:      '#ea4335',
        balanced:      '#10b981',
    });

    var ThemeGuard = {
        /**
         * Colour constants for use in JS-driven rendering (charts, injected rows).
         * Example: ctx.fillStyle = ThemeGuard.tokens.accent;
         */
        tokens: TOKENS,
        /**
         * Register a callback that runs after the theme is fully applied.
         * Use this in pages that dynamically render content (e.g. after API calls)
         * and need to re-apply theme tokens to freshly injected HTML.
         *
         * Example:
         *   ThemeGuard.onReady(function() {
         *     document.querySelectorAll('.my-new-component').forEach(applyDarkStyle);
         *   });
         */
        onReady: function (fn) {
            if (typeof fn === 'function') {
                _hooks.push(fn);
            }
        },

        /**
         * Manually trigger all registered onReady hooks.
         * Call this after dynamically rendering a section (e.g. after loadData()).
         *
         * Example:
         *   loadReportData().then(function() {
         *     renderReportTable(data);
         *     ThemeGuard.refresh();
         *   });
         */
        refresh: function () {
            _hooks.forEach(function (fn) {
                try { fn(); } catch (e) { /* silent — don't break app for theme issues */ }
            });
        },

        /**
         * Returns true — useful for feature detection by other scripts.
         */
        isDark: function () {
            return document.documentElement.getAttribute('data-theme') === 'dark';
        },

        /**
         * CSS variable accessor — reads a computed CSS variable value.
         * Example: ThemeGuard.cssVar('--accent') → '#f59e0b' (approximately)
         */
        cssVar: function (name) {
            return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        }
    };

    // ── 5. Initialise ─────────────────────────────────────────────────────────
    ensureDarkThemeCSS();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            applyBodyClass();
            ThemeGuard.refresh();
        });
    } else {
        applyBodyClass();
        ThemeGuard.refresh();
    }

    // Expose globally
    window.ThemeGuard = ThemeGuard;

}());
