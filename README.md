# DumpsterGames + Dumpster Divers Desktop + Diver Social Website

This package has three parts:

1. `desktop/` — a single-player Windows desktop build of Dumpster Divers. It wraps the existing 3D scavenging game in Electron, keeps saved accounts/progress on the computer, bundles Three.js locally, and adds badges that award Pennys.
2. The root `index.html`, `config.js`, and `app.js` — a pixel-themed player website with registration/sign-in, editable avatar, friends, friend requests, public friend avatar/coin cards, a leaderboard, timed Pennys, and badges that award Pennys.
3. `.github/workflows/build-windows.yml` — a GitHub Actions workflow that compiles the Windows installer and portable `.exe` for you. The current build environment is Linux, so the Windows EXE is built by GitHub's Windows runner rather than pretending a ZIP is an EXE.

## Desktop game

- Open `desktop/` in a terminal on Windows and run `npm install`, then `npm start` for a developer preview.
- For the actual Windows app, use the included GitHub Actions workflow. It builds `Dumpster-Divers-Portable-1.1.0-x64.exe` and an installer.
- The game server binds to `127.0.0.1` only and allows one player, so this release is not a multiplayer server.
- Save data is stored in the operating system's application-data folder, not inside the install folder.
- Game accounts and Penny/badge progress currently live in the desktop app's local save. They are not yet synced to website accounts.

## Website: preview mode

Open the root `index.html` through a local web server (for example VS Code Live Server). Preview mode allows testing registrations, friends, avatars, badges and rewards in the same browser. Local preview accounts are **not online** and are not a substitute for secure authentication.

## Make the website's accounts truly online (one-time setup)

A static GitHub Pages website cannot itself hold shared user accounts. To make logins, friends, badges and Pennys visible to other people, connect a free Supabase project as the website's database/auth provider. Players still stay on your website; this only gives the website a cloud database behind the scenes.

1. Create a Supabase project at https://supabase.com/.
2. In that project's SQL Editor, paste all of `schema.sql` and run it.
3. In Supabase project settings, copy the Project URL and the public publishable/anon key. Never use a service-role/secret key in website code.
4. Open `config.js`. Replace `https://YOUR-PROJECT.supabase.co` with the Project URL and replace `YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY` with the public key.
5. Upload the root `index.html`, `config.js`, and `app.js` to your GitHub Pages repository (or place them together in the intended folder).
6. In Supabase Auth settings, configure the Site URL and Redirect URLs to include your GitHub Pages URL, for example `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`. For a custom domain, add that address too.
7. Test by registering two accounts in separate browser profiles. One user searches the other's username, sends a friend request, the second accepts; then each can see the other's avatar, Pennys and badges.

### Website badge rewards

- Fresh Diver: +10 Pennys, automatically at sign-up (the account starts with 10, so the displayed initial balance is 20).
- Style Icon: +15 Pennys when you save a custom avatar.
- Crew Starter: +25 Pennys when you accept your first friend.
- Crew Builder: +50 Pennys after reaching three friends.
- Penny Hoarder: +35 Pennys after earning 100 Pennys total.
- The website grants 1 Penny every 15 minutes using a database-side timer so the browser clock cannot simply be edited to claim more.

## Important boundaries

- You must configure the website cloud backend once for cross-device online account sharing. The included no-config preview is browser-local.
- The website social profiles and desktop game's local player saves are separate in this version. Website friend profiles show the website's cloud profile Pennys and badges; offline game achievements are saved inside the desktop game. Linking those balances would require a shared online game API or an additional account-sync integration.
- This is a hobby project. Test with throwaway credentials; don't use a password you rely on elsewhere.


## Getting the Windows EXE from GitHub Actions

1. In your GitHub repo, use GitHub Desktop or the browser uploader to put these files/folders in the repository root: `index.html`, `config.js`, `app.js`, `schema.sql`, `.github/workflows/build-windows.yml`, and the whole `desktop/` folder. Keep the folder names exactly as shown.
2. Commit and push the files. If the workflow does not start automatically, open the repo's **Actions** tab, choose **Build Dumpster Divers for Windows**, click **Run workflow**, and run it on the `main` branch.
3. Wait for the green checkmark, open the completed workflow run, and scroll to **Artifacts**. Download `Dumpster-Divers-Windows`.
4. Extract that artifacts ZIP. It contains a portable `.exe` and a Windows installer `.exe`. Run the portable version or install the installer. Windows may show a SmartScreen warning because the hobby app is not code-signed. Only run software you trust.
5. To add the download to the website, create and push a Git tag starting with `v` (for example `v1.1.0`) from GitHub Desktop or Git. The workflow publishes the EXEs as a GitHub Release. Then replace `YOUR-USERNAME` and `YOUR-REPOSITORY` in `config.js`; the website will show the **DOWNLOAD EXE** button.

The website social profiles need the Supabase setup described above. The app's local game save is separate from the cloud website profile in this version; do not expect a game badge earned in the desktop app to update a website balance automatically.
