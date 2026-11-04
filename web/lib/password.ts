const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_+';

export function generateStrongPassword(): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let password: string;
  do {
    password = '';
    while (password.length < 24) {
      for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        if (byte < limit && password.length < 24) password += alphabet[byte % alphabet.length];
      }
    }
  } while (
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/\d/.test(password) ||
    !/[!@#$%*\-_+]/.test(password)
  );
  return password;
}
