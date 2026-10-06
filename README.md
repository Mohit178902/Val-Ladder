# Ladder (Valorant) - test build

Static page (`index.html`) plus one serverless function (`api/state.js`). Shared state lives in a Redis database, so you and your friends see the same queue, matches and leaderboard.

## Deploy
1. Push this folder to a GitHub repo (or run `npx vercel` inside it).
2. Import the repo at vercel.com/new. No build settings needed.
3. In the project, open Storage (Marketplace), add an Upstash Redis database, and connect it to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` (the function also accepts `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).
4. Add environment variables:
   - `MIN_PLAYERS` - players needed to start a match (default 10; use 2 to test with one friend)
   - `MOD_BOOTSTRAP` - Riot ID(s), comma separated, that become moderators when they sign up or sign in, e.g. `Boss#EUW,Helper#1234`
5. Redeploy so the variables apply, then share the URL.

## Limits of this test build
- Accounts: username + password (hashed with scrypt) plus a Riot ID and a profile screenshot. New accounts stay pending until a moderator approves them in the Moderator tab; only approved accounts can queue or appear on the leaderboard.
- No password reset, email, or rate limiting yet.
- Two actions at the same instant can overwrite each other.
- Screenshot checks are by the two leaders and a moderator; nothing reads the image automatically.
- Data lives in Redis keys `ladder2`, `proof:<username>` and `shot:<matchId>`; delete them to reset.

## Accounts and chat (added)
- New players create an account with Riot ID, password and a profile screenshot. They stay pending until a moderator approves them in the Moderator tab (moderators only). Only approved players can queue or appear on the leaderboard.
- Each match has a chat for its players. The Team A leader creates the custom game in Valorant, types its party code, and presses "Announce party code". That posts the code in chat with the message: keep the cheats off and no pauses only timeouts. Nobody else can announce a code.
- Passwords are stored as salted scrypt hashes. Sessions use a token kept in the browser.

## Moderator accounts (added)
- Moderators are normal accounts with a `mod` role. List your own Riot ID in `MOD_BOOTSTRAP` first; that account becomes a moderator and is approved automatically.
- Moderators can queue and play like anyone, and also: approve or reject new accounts, resolve disputes, void any open match, delete chat messages, ban or unban players, and make or remove other moderators.
- Regular players never see the Moderator tab, and the server rejects every moderator action from a non-moderator account.
