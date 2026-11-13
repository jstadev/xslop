// Build-time constants (build.mjs, esbuild define). Tests define them in vitest.config.ts.
declare const __XSLOP_API__: string;
declare const __XSLOP_VERSION__: string;
declare const __MIN_MUTE_SEC__: number;
declare const __MARK_SVG__: string;
/** 'open' only in the e2e test build; release builds use closed shadow roots. */
declare const __SHADOW__: string;
