// Passkeys in the browser: the relay's options turned into WebAuthn's,
// and the browser's answer turned back into base64url for the relay,
// which checks everything itself (claude-relay/src/webauthn.ts).

export function toBase64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  const clean = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function passkeysSupported() {
  return typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.create === "function";
}

/** A new passkey for the options of /web/passkey/register/options. */
export async function createPasskey(publicKey) {
  const credential = await navigator.credentials.create({
    publicKey: {
      ...publicKey,
      challenge: fromBase64url(publicKey.challenge),
      user: { ...publicKey.user, id: fromBase64url(publicKey.user.id) },
      excludeCredentials: [],
    },
  });
  if (!credential) throw new DOMException("no credential", "NotAllowedError");
  const response = credential.response;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}

/** A signature with one of this site's passkeys for /web/passkey/login/options. */
export async function usePasskey(publicKey) {
  const credential = await navigator.credentials.get({
    publicKey: { ...publicKey, challenge: fromBase64url(publicKey.challenge), allowCredentials: [] },
  });
  if (!credential) throw new DOMException("no credential", "NotAllowedError");
  const response = credential.response;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : null,
    },
  };
}

/** Tells the browser that a passkey of this site no longer opens anything here, where it can be told. */
export async function forgetPasskey(rpId, credentialId) {
  try {
    if (typeof window.PublicKeyCredential?.signalUnknownCredential === "function") {
      await window.PublicKeyCredential.signalUnknownCredential({ rpId, credentialId });
    }
  } catch {
    // Only a courtesy to the password manager.
  }
}

/** A fresh admin key for the first setup: 32 random bytes, made here and sent nowhere. */
export function newAdminKey() {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}
