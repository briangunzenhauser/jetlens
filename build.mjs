// Builds the shippable page: index.html -> dist/index.html.
//
// index.html is the source, and it is meant to stay readable -- roughly a third of
// its bytes are comments, most of them explaining the orientation maths, which is
// the part of this app that is genuinely hard to get right. None of that should
// reach a phone on a cellular connection, and none of it should be deleted to
// achieve that. Hence a build step rather than minifying in place.
//
// Netlify serves brotli already, so the honest measure of this is compressed
// bytes, not raw ones: ~20.9 kB brotli before, ~8.2 kB after.
//
// Usage: node build.mjs [--watch]

import { readFileSync, writeFileSync, mkdirSync, watch } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, 'index.html');
const OUT_DIR = join(root, 'dist');
const OUT = join(OUT_DIR, 'index.html');

// The inline <script>, matched so that the Umami tag -- which has a src and no body
// -- is left alone. Rewriting that one would strip the attributes it is loaded for.
const INLINE_SCRIPT = /(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/i;
const STYLE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/i;

async function build() {
    const src = readFileSync(SRC, 'utf8');

    const scriptMatch = src.match(INLINE_SCRIPT);
    const styleMatch = src.match(STYLE);
    if (!scriptMatch) throw new Error('no inline <script> found in index.html');
    if (!styleMatch) throw new Error('no <style> found in index.html');

    // Wrapping the script in an IIFE lets esbuild shorten the top-level names too.
    // Safe only because nothing outside reaches in: the markup carries no inline
    // on* handlers, and the script assigns nothing to window. Both are asserted
    // below so that adding one later fails the build instead of the page.
    assertNoGlobalEntryPoints(src, scriptMatch[2]);

    const js = await esbuild.transform(`(()=>{${scriptMatch[2]}})()`, {
        loader: 'js',
        minify: true,
        target: 'es2020', // Safari 14+, which is the floor for the sensor APIs anyway
        legalComments: 'none',
    });
    for (const w of js.warnings) console.warn('esbuild:', w.text);

    const css = new CleanCSS({ level: 2, returnPromise: false }).minify(styleMatch[2]);
    if (css.errors.length) throw new Error('clean-css: ' + css.errors.join(', '));
    for (const w of css.warnings) console.warn('clean-css:', w);

    const withAssets = src
        .replace(INLINE_SCRIPT, (_, open, __, close) => open + js.code + close)
        .replace(STYLE, (_, open, __, close) => open + css.styles + close);

    const html = await minifyHtml(withAssets, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeAttributeQuotes: true,
        collapseBooleanAttributes: true,
        useShortDoctype: true,
        // Both are already minified above, and re-running them here would only
        // undo the IIFE wrapper's name shortening.
        minifyCSS: false,
        minifyJS: false,
    });

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT, html);

    const kb = n => (n / 1024).toFixed(1) + ' kB';
    console.log(`built dist/index.html  ${kb(src.length)} -> ${kb(html.length)} raw ` +
                `(${Math.round((1 - html.length / src.length) * 100)}% smaller)`);
}

// The IIFE wrapper turns every top-level declaration into a local. That is what
// allows the names to be shortened, and it is invisible so long as nothing outside
// the script depends on those names. These are the two ways something could.
function assertNoGlobalEntryPoints(src, js) {
    const markupOnly = src.replace(INLINE_SCRIPT, '').replace(STYLE, '');
    const handler = markupOnly.match(/\son[a-z]+\s*=\s*["']/i);
    if (handler) {
        throw new Error(
            `inline "${handler[0].trim()}" handler in the markup would call into the ` +
            `script, but the build wraps it in an IIFE. Bind the listener in JS instead.`);
    }

    const exported = js.match(/\b(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=(?!=)/);
    if (exported) {
        throw new Error(
            `the script assigns to a global ("${exported[0].trim()}"), which the IIFE ` +
            `wrapper would hide from anything outside. Remove it, or drop the wrapper.`);
    }
}

await build();

if (process.argv.includes('--watch')) {
    console.log('watching index.html -- ctrl-c to stop');
    let pending = null;
    watch(SRC, () => {
        clearTimeout(pending); // editors save in bursts; rebuild once they settle
        pending = setTimeout(() => build().catch(e => console.error('build failed:', e.message)), 80);
    });
}
