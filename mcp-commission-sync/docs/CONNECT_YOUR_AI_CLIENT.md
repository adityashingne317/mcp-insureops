# Connecting your AI assistant to Commission Sync

This guide will help you connect your AI assistant (Cursor, Claude Desktop,
or ChatGPT) so it can look up and help update commission rules for you.

**You do not need to install any software or understand any code to do
this.** Just follow the steps below and copy-paste exactly what's shown.

There is only **one thing** you need before you start:

> ### 🔗 Your company's setup link
> Ask your admin/IT contact for this link if you don't already have it:
>
> **`[ COMPANY-SETUP-LINK ]`**
>
> Every time you see `[ COMPANY-SETUP-LINK ]` in this guide, it means
> "the link your admin gave you." Everywhere else, you'll just be
> copy-pasting things - no typing or editing required.

---

## Which section should I read?

Look at which app you use to chat with AI, then jump to that section only:

- I use **Cursor** → go to [Option A](#option-a-cursor)
- I use **Claude Desktop** (the Claude app on my computer) → go to
  [Option B](#option-b-claude-desktop)
- I use **ChatGPT** → go to [Option C](#option-c-chatgpt)

---

## Step 1 (everyone does this first) - Get your personal access code

1. Open a web browser and go to: `[ COMPANY-SETUP-LINK ]`
2. Sign in with your **normal InsureOps email and password** - the exact
   same login you already use every day for InsureOps. There's nothing new
   to create or remember.
3. You'll land on a page with a gray/black box containing some text starting
   with `{` - this is your personal access code. It's already filled in
   with your details; you don't need to write or change anything in it.
4. Click inside that box and select all the text, then copy it (on most
   computers: click inside, press `Ctrl+A` or `Cmd+A` to select everything,
   then `Ctrl+C` or `Cmd+C` to copy).
5. Keep this browser tab open - you'll come back to copy from it again in
   the next step.

**One thing to remember:** this access code stops working after about a day
(24 hours), as a security measure. If your assistant suddenly stops being
able to answer questions about commission rules, just come back to this same
link, sign in again, and repeat the step for your app below with the new
code. It only takes a minute.

---

## Option A: Cursor

1. Open Cursor.
2. Click the gear icon (⚙️) for **Settings**, then find **MCP** in the list
   on the left.
3. Click **Add new MCP server** (or **+ Add**).
4. There should be a box where you can paste text. Paste the whole code you
   copied in Step 1 into it, exactly as it is, then save.
5. If nothing seems to happen within about 10 seconds, find "commission-sync"
   in that same MCP settings list and click the switch next to it to turn it
   off, then on again.
6. That's it. Start a new chat and try asking: *"List all insurers for my
   tenant."* If you get a real answer back, you're connected.

---

## Option B: Claude Desktop

Claude Desktop needs one extra small step compared to Cursor, but it's still
just copy-pasting - no typing required.

**Before you start:** this option needs a free helper program called
Node.js installed on your computer. If you're not sure whether you have it,
ask your IT contact to install it for you first (it takes them two minutes) -
[nodejs.org](https://nodejs.org) if they need the link.

1. Open Claude Desktop.
2. Click **Claude** in the top menu (or the settings/gear icon), then find
   **Settings → Developer → Edit Config**. This opens a text file.
3. Look at the code you copied in Step 1. It will look like this shape
   (yours will have real text instead of the dots):

   ```json
   {
     "mcpServers": {
       "commission-sync": {
         "url": "https://.......… /mcp",
         "headers": {
           "Authorization": "Bearer ......................."
         }
       }
     }
   }
   ```

4. In the file that opened in Claude Desktop, carefully add a new entry
   using the pattern below. Replace only the two `PASTE-...-HERE` parts -
   take the web address from between the `"url": "..."` quotes in your copied
   code, and the long code from after `Bearer` in your copied code:

   ```json
   {
     "mcpServers": {
       "commission-sync": {
         "command": "npx",
         "args": [
           "-y",
           "mcp-remote",
           "PASTE-YOUR-WEB-ADDRESS-HERE",
           "--header",
           "Authorization: Bearer PASTE-YOUR-LONG-CODE-HERE"
         ]
       }
     }
   }
   ```

   If the file already has other things listed inside `"mcpServers": { ... }`,
   don't delete them - just add `"commission-sync": { ... }` alongside them,
   with a comma between entries. If none of this makes sense, don't worry -
   ask your IT contact to do this one-time step for you; it only takes a
   minute once they have your access code from Step 1.
5. Save the file.
6. **Fully close Claude Desktop and reopen it** (not just close the window -
   quit the app completely). Claude Desktop only checks this file when it
   starts up.
7. Start a new chat and try asking: *"List all insurers for my tenant."* If
   you get a real answer back, you're connected.

---

## Option C: ChatGPT

**Please read this first:** as of today, ChatGPT is the trickiest of the
three to connect, and it may simply not work yet - this is a limitation on
ChatGPT's side, not something wrong with your account. If it doesn't work,
please use Cursor or Claude Desktop instead for now.

1. You'll need a paid ChatGPT plan (Plus or higher) - it's not available on
   the free plan.
2. In ChatGPT, go to **Settings**, then look for **Connectors** (sometimes
   under **Security and login** instead - check both if you don't see it),
   and turn on **Developer Mode**.
3. Go back to **Settings → Connectors**, click the **+** button, and choose
   to create a custom connector.
4. Give it a name like "Commission Sync" and, when asked for a web address,
   paste in `[ COMPANY-SETUP-LINK-WITHOUT-/setup, PLUS /mcp ]` (ask your
   admin for this exact address if unsure - it's slightly different from the
   link in Step 1).
5. If ChatGPT then asks you to "Sign in" (rather than asking for a code you
   paste in), that's the point where it currently won't work with this tool.
   Please switch to Cursor or Claude Desktop instead.

---

## How do I know it's working?

In a new chat, in whichever app you set up, type one of these and send it:

- *"List all insurers for my tenant."*
- *"Show me the current commission schedules for [any product name you
  know]."*

If you get back real information (not an error message), you're all set.
From here, you can simply describe what you want in plain English - for
example, "an insurer sent me a new rate card, here's what it says..." - and
the assistant will handle the rest. **It will always show you exactly what
it's about to change and ask you to confirm before saving anything** - it
will never make a change without your explicit "yes."

---

## Something not working? Check here first

| What you're seeing | What's likely happening | What to do |
|---|---|---|
| The assistant doesn't seem to have the tools at all | The setup step didn't save correctly | Go back through the steps for your app above; for Claude Desktop, make sure you fully quit and reopened the app |
| It suddenly stops working after it worked before | Your access code expired (this happens after ~24 hours, on purpose) | Go back to `[ COMPANY-SETUP-LINK ]`, sign in again, and repeat the copy-paste step |
| A colleague sees more options/tools than you do | This is normal, not a bug | You each only see what you're personally allowed to do in InsureOps - it matches your own account exactly |
| A change you expected to happen didn't happen | It's likely waiting on your confirmation | The assistant always asks "should I go ahead?" before saving any change - check if it's waiting on your reply |
| ChatGPT asks you to "sign in" instead of accepting your code | Known current limitation (see Option C above) | Use Cursor or Claude Desktop instead for now |

---

## Good to know

- This tool can **look up** insurer, product, plan, and commission rule
  information any time you ask - it's always live, real information.
- It can **prepare** a new or changed commission rule for you to review.
- It will **never save a change automatically** - it always shows you the
  details first and waits for you to say yes.
- It can only ever do what your own InsureOps account is already allowed to
  do - it doesn't give you any extra access you don't already have.
