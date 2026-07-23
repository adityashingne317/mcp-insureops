# Connect Commission Sync to Cursor

Two steps. No installing anything, no typing code - just log in, copy, and
paste.

---

## What you need before starting

Your admin/IT contact should give you one link. It will look something like
this (ask them for the real one):

> **`[ COMPANY-SETUP-LINK ]`**

---

## Step 1 - Log in and copy your personal code

1. Open the link above in your web browser.
2. Sign in with your **normal InsureOps email and password** - the exact
   login you already use every day. Nothing new to create.
3. You'll see a dark box on the page containing something like this (yours
   will have your own real web address and a long code instead of the dots
   below - this is just an example so you know what to expect):

   ```json
   {
     "mcpServers": {
       "Insureops MCP": {
         "url": "https://example-company.com/mcp",
         "headers": {
           "Authorization": "Bearer ..........................."
         }
       }
     }
   }
   ```

4. Click anywhere inside that box, select everything in it, and copy it:
   - Click once inside the box
   - Press `Cmd+A` (Mac) or `Ctrl+A` (Windows) to select all of it
   - Press `Cmd+C` (Mac) or `Ctrl+C` (Windows) to copy it

That's the only "technical" part, and it's just copying text - you're done
with InsureOps for now.

---

## Step 2 - Paste it into Cursor

1. Open **Cursor**.
2. Click the gear icon ⚙️ in the bottom left (or top right, depending on your
   version) to open **Settings**.
3. In the settings search box, type **MCP** and click on the **MCP** section.
4. Click **Add new global MCP Server** (or the **+** button next to "MCP
   Servers").
5. This opens a small text file for editing. It probably looks empty, or
   like this:

   ```json
   {
     "mcpServers": {

     }
   }
   ```

6. Click inside the `{ }` curly braces and **paste** the code you copied in
   Step 1 (`Cmd+V` on Mac, `Ctrl+V` on Windows), replacing anything that was
   already there. Once pasted, the whole file should look exactly like the
   box you copied from InsureOps.
7. Save the file (`Cmd+S` on Mac, `Ctrl+S` on Windows).
8. Go back to the MCP settings list - you should see **Insureops MCP**
   appear with a toggle switch. Make sure it's turned **on**. If it doesn't
   turn on by itself, click the toggle off and back on once.

**You're connected.** Open a new chat in Cursor and try typing:

> *List all insurers for my tenant.*

If you get a real answer back (not an error), everything is working.

---

## One thing to remember

Your personal code stops working after about a day (24 hours) - this is a
normal security measure, not a mistake. If Cursor suddenly can't answer
questions about commission rules anymore, just:

1. Go back to `[ COMPANY-SETUP-LINK ]` and sign in again
2. Copy the new code it gives you
3. Repeat Step 2 above with the new code (it replaces the old one)

It takes less than a minute.

---

## If something doesn't look right

| What you see | What to do |
|---|---|
| Nothing shows up under MCP Servers after pasting | Make sure you saved the file, then go back and toggle "Insureops MCP" off and on |
| An error about the file / JSON | You may have pasted only part of the code, or pasted it twice. Delete everything in the file and paste fresh, starting from `{` and ending at the last `}` |
| It worked yesterday, not today | Your code expired (see "One thing to remember" above) - just repeat Step 1 and 2 with a fresh one |
| You see fewer options than a colleague | Normal - everyone only sees what their own InsureOps account is allowed to do |

---

## What this tool will and won't do

- It can **look up** insurers, products, plans, and commission rules -
  always live, real, current information from InsureOps.
- It can **prepare** a new or changed commission rule and show you exactly
  what it would look like.
- It will **never save any change without asking you first** - it always
  shows you the details and waits for your explicit "yes."
- It can only do what your own account is already allowed to do in
  InsureOps - nothing more.

---

## Prefer to skip the copy-paste? (optional, for technical users)

There's also a small script that does Step 1 and Step 2 for you
automatically - it logs in and writes the config into Cursor by itself, no
copying or pasting required. See
[`scripts/connect-cursor.mjs`](../scripts/connect-cursor.mjs) if you'd rather
run one command in a terminal instead. Most people should just use the two
steps above.
