import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";

async function refreshAccessToken(token: any) {
  try {
    const url = "https://oauth2.googleapis.com/token";

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const refreshed = await res.json();

    if (!res.ok) throw refreshed;

    return {
      ...token,
      accessToken: refreshed.access_token,
      accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
      // manchmal kommt kein neuer refresh_token zurück, dann alten behalten
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
    };
  } catch (e) {
    console.error("REFRESH_TOKEN_ERROR", e);
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "openid email profile https://www.googleapis.com/auth/drive.file",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account }) {
      // Erstes Login
      if (account) {
        return {
          accessToken: account.access_token,
          accessTokenExpires: (account.expires_at ?? 0) * 1000, // ms
          refreshToken: account.refresh_token, // kommt meist nur beim ersten consent
          user: token.user,
        };
      }

      // Wenn Token noch gültig ist -> so lassen
      const expires = Number((token as any).accessTokenExpires ?? 0);
      if ((token as any).accessToken && expires && Date.now() < expires)  {
        return token;
      }

      // Token abgelaufen -> refresh
      if (!(token as any).refreshToken) {
        return { ...token, error: "NoRefreshToken" };
      }

      return await refreshAccessToken(token);
    },

    async session({ session, token }) {
      // @ts-expect-error
      session.accessToken = token.accessToken;
      // @ts-expect-error
      session.authError = token.error ?? null;
      return session;
    },
  },
};
