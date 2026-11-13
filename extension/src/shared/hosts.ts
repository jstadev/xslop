// The X sites that xslop runs on. build.mjs holds the same list for the manifests; a build test keeps the two equal.
export const X_ORIGINS: readonly string[] = ['https://x.com', 'https://twitter.com', 'https://mobile.x.com'];

/** The same sites as match patterns. */
export const X_MATCHES: string[] = X_ORIGINS.map((o) => `${o}/*`);

export const isXUrl = (url: string): boolean => X_ORIGINS.some((o) => url.startsWith(`${o}/`));
