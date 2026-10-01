/**
 * CLI om een wachtwoord-hash voor de goedkeuringspagina (SPEC §12) te
 * genereren. Vraagt het wachtwoord twee keer op zonder echo en toont de hash;
 * zet die zelf in `.env` of in de Railway-secrets als `ADMIN_PASSWORD_HASH`.
 *
 * Gebruik: `npm run admin:hash`
 */

import { maakWachtwoordHash } from '../src/admin/wachtwoord.ts';

async function leesWachtwoord(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new Error(
      'Dit script heeft een echte terminal nodig (geen TTY beschikbaar). Draai het interactief.',
    );
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 3) {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          reject(new Error('Afgebroken door gebruiker.'));
          return;
        }
        if (code === 13 || code === 10) {
          // Enter
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(buffer);
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (code < 32) continue; // overige controltekens negeren
        buffer += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const w1 = await leesWachtwoord('Nieuw wachtwoord voor Rubert (verborgen): ');
  if (w1.length < 8) {
    process.stderr.write('Wachtwoord moet minstens 8 tekens zijn. Afgebroken.\n');
    process.exit(1);
  }
  const w2 = await leesWachtwoord('Herhaal wachtwoord: ');
  if (w1 !== w2) {
    process.stderr.write('Wachtwoorden komen niet overeen. Afgebroken.\n');
    process.exit(1);
  }
  const hash = await maakWachtwoordHash(w1);
  process.stdout.write('\nZet deze regel in .env (of in de Railway-secrets):\n\n');
  process.stdout.write(`ADMIN_PASSWORD_HASH=${hash}\n\n`);
}

main().catch((err) => {
  process.stderr.write(`Fout: ${(err as Error).message}\n`);
  process.exit(1);
});
