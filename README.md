<div align="center">

# 📋✅ Tester Manager

**Publish acceptance tests. Watch testers answer them live.**

A small, self-hosted web app. The admin writes tests in Markdown, and testers
mark each one PASS / FAIL / N/A, leave feedback, and report problems. It all
updates in real time.

![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a)
![Express](https://img.shields.io/badge/express-5-222)
![SQLite](https://img.shields.io/badge/sqlite-built--in-0f80cc)
![Dependencies](https://img.shields.io/badge/dependencies-1-orange)
![Vibe coded](https://img.shields.io/badge/vibe%20coded-Claude%20Opus%205-d97757)

</div>

> [!CAUTION]
> **Intended for local use or small, trusted groups. Don't host it publicly.**
>
> This app keeps security basic on purpose, to stay simple:
> - **Passwords are stored readable.** Testers can see their own password in their profile, and the admin can see every tester's password.
> - **The admin password is a plain text file** (`admin-credentials.txt`) next to the code.
> - **There's no login-attempt limit and no built-in HTTPS.** Anyone who can reach the site can keep guessing passwords, and plain `http://` traffic can be read on the network.
> - **Anyone with the link can sign up** as a tester.
>
> Run it on `localhost` or your own network. When you need to share it, use a temporary tunnel (like ngrok) for the length of a testing round, then close it. Ask testers **not to reuse a password** they use anywhere else.

---

## ✨ What it does

| For the **admin** | For **testers** |
| --- | --- |
| Paste or upload a Markdown test document to publish it | Sign up themselves and see every published document |
| Edit a document later; testers' answers are kept | Mark each test **PASS**, **FAIL** or **N/A**, with feedback and screenshots |
| See each tester's answer sheet and an overview of results | Report **problems** found while testing a document |
| Post comments on a document, and testers get a bell alert | Raise general **concerns** and follow their status |
| Set concern status (**On-hold · On-process · Applied**), hide concerns, filter by tester | Manage their own profile, or delete their account |
| Manage users, see who's online, and download results as PDF | Get alerts right away, with no page refresh |

It works on phones, tablets and desktops, and has light and dark themes (it
follows your device by default).

---

## 🚀 Setup

### 1. Requirements

- **[Node.js](https://nodejs.org) 22.13 or newer.** Check with `node -v`.

That's all. The database is SQLite, which is built into Node, so there's nothing else to install.

### 2. Install

```bash
git clone https://github.com/haroisded/Tester-Manager.git
cd Tester-Manager
npm install
```

### 3. Start

```bash
npm start
```

You should see:

```
Tester Manager running at http://localhost:3000
```

Open **http://localhost:3000** in your browser.

### 4. Sign in as admin

On first start, the server creates **`admin-credentials.txt`** with a random password:

```
username: admin
password: <random>
```

Sign in with those. To change them, edit the two lines and restart the server.

> [!WARNING]
> `admin-credentials.txt` holds the password in plain text. It's git-ignored, so keep it that way.

### 5. Invite testers

Share the link. Testers create their own accounts on the sign-in page.

To share beyond your own network, use a tunnel such as [ngrok](https://ngrok.com):

```bash
ngrok http 3000
```

Send testers the `https://…ngrok…` address it prints.

---

## 📝 Writing a test document

A document is plain Markdown. Each test starts with a `## Test N - Title: …` heading:

```markdown
# Resources

Short intro shown above the tests.

## Test 1 - Title: Resources opens and closes its three screens

### What will be tested?
That tapping **Resources** only shows or hides the screens under it.

### Steps
1. Open the side menu.
2. Tap **Resources**.

### What's the expected output?
- Products, Rentables and Inventory appear under Resources.

## Test 2 - Title: …
```

It supports headings, `-` and `1.` lists, **bold** and paragraphs. See
[`sample-structure/resources.md`](sample-structure/resources.md) for a full example.

---

## ⚙️ Configuration

| Setting | How | Default |
| --- | --- | --- |
| Port | `PORT` environment variable | `3000` |
| Admin login | edit `admin-credentials.txt`, then restart | generated on first start |

```bash
# macOS / Linux
PORT=8080 npm start

# Windows PowerShell
$env:PORT=8080; npm start
```

---

## 🗂️ Project layout

```
server.js        API, auth, database and live updates (Server-Sent Events)
md.js            Test document parser and Markdown renderer
public/          The web app: pages, scripts and styles
sample-structure/  Example test document
```

Created on first run (and git-ignored):

```
data.db                 All users, tests, answers and concerns
uploads/                Screenshots testers attach
admin-credentials.txt   Admin login
```

---

## 🧰 Maintenance

- **Back up:** stop the server, then copy `data.db` and the `uploads/` folder.
- **Start fresh:** stop the server, then delete `data.db` and `uploads/`. They're recreated empty.
- **Update:** pull the new code and restart. Database changes are applied automatically on start.
- **Self-check:** `npm run check` runs the Markdown parser's tests.

---

<div align="center">
<sub>A private side project. It's meant for small teams on trusted links, not the open internet.</sub>
<br>
<sub>✨ Entirely vibe coded with <b>Claude Opus 5</b></sub>
</div>
