# Installing Datamosh (permanently)

After this, Datamosh is a normal Premiere Pro plugin: it's always under
**Window > UXP Plugins > Datamosh**, survives restarts, and you never load it through
UXP Developer Tools again.

Windows only. Needs **Premiere Pro 25.6 or newer** and the **Creative Cloud desktop app**
(it contains Adobe's plugin installer).

---

## Quick install (one click)

1. **Download the project.** On the GitHub page click **Code > Download ZIP**, or:

   ```bash
   git clone https://github.com/krugwalk/datamosh-premiere.git
   ```

2. **Put the folder somewhere permanent**, e.g. `C:\Tools\datamosh-premiere`
   (not your Downloads folder). The plugin and the helper run from this folder, so
   don't move or delete it afterwards. If you do move it, run `setup.bat` again.
3. **Close Premiere Pro.**
4. **Double-click `setup.bat`.** It:
   - checks Python 3 and installs the Python packages (`requirements.txt`),
   - checks ffmpeg and offers to install it with winget,
   - installs the panel into Premiere with Adobe's own installer,
   - sets the helper to start hidden every time Windows starts.
5. **Open Premiere Pro** and choose **Window > UXP Plugins > Datamosh**. Dock the panel
   wherever you like; Premiere remembers it. The dot at the top right should say
   **helper online**.

That's it. Next time you open Premiere it's simply there.

---

## Manual install (step by step)

Use this if `setup.bat` stops with an error, or you'd rather do it yourself.

### 1. Python 3

Install from [python.org](https://www.python.org/downloads/) and tick
**Add python.exe to PATH** in the installer (or `winget install Python.Python.3.12`).
Check in a new Command Prompt:

```bash
python --version
```

Then install the packages (used by Colour clocks and Targeted mosh):

```bash
python -m pip install -r requirements.txt
```

### 2. ffmpeg

```bash
winget install Gyan.FFmpeg
```

Or download a build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) and add its
`bin` folder to PATH. Check with `ffmpeg -version` in a new Command Prompt.

### 3. Install the panel into Premiere Pro

Close Premiere Pro, then double-click **`install_plugin.bat`**.

It packages the `panel` folder as `build\datamosh.ccx` and installs it with Adobe's
Unified Plugin Installer Agent (part of Creative Cloud), the same way plugins from the
Adobe Marketplace are installed. You should see:

```
Installation Successful ...
Installed. Restart Premiere Pro, then open Window > UXP Plugins > Datamosh.
```

> You can also double-click `build\datamosh.ccx` after running it once: Creative Cloud
> opens and installs it the same way.

### 4. Start the helper with Windows

Double-click **`install_autostart.bat`**. Premiere panels aren't allowed to run
programs like ffmpeg, so a small local helper (`127.0.0.1:8765`, never reachable from
other computers) does the encoding. This puts it in your Startup folder so it runs
hidden from now on. No window stays open; messages go to `helper.log`.

Not wanted? Skip it and click **Start helper** in the panel's red banner when needed,
or double-click `datamosh_helper.pyw`.

### 5. Open it

Start Premiere Pro, then open **Window > UXP Plugins > Datamosh**.

---

## Updating

1. Download the new version into the **same folder** (or `git pull`).
2. Run `stop_helper.bat`, close Premiere, and run `setup.bat` (or `install_plugin.bat`
   and `install_autostart.bat`) again.
3. Open Premiere.

## Uninstalling

- `uninstall_plugin.bat` removes the panel from Premiere.
- `uninstall_autostart.bat` stops the helper and removes it from Windows startup.
- Then delete the folder.

You can also remove the plugin from the Creative Cloud app: **Stock & Marketplace >
Plugins > Manage plugins**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **Datamosh isn't under Window > UXP Plugins** | Restart Premiere Pro after installing. Check that Premiere is 25.6 or newer. |
| **Installer says `Failed to install`** | Close Premiere Pro and run `install_plugin.bat` again. Make sure the Creative Cloud app is installed and signed in. |
| **Premiere still shows the old version** | Raise `version` in `panel/manifest.json`, run `install_plugin.bat`, restart Premiere. |
| **The panel says *helper offline*** | Run `install_autostart.bat`, or click **Start helper** in the panel. Check `helper.log` in the folder for errors. |
| **`Could not find ffmpeg`** in the log | Install ffmpeg (step 2), then run `stop_helper.bat` and start the helper again so it sees the new PATH. |
| **Colour clocks / Targeted mosh error about numpy or cv2** | `python -m pip install -r requirements.txt` |
| **Start helper button does nothing** | You moved the folder after installing. Run `setup.bat` again from the new location. |
| **Plugin listed twice / conflicts** | If you also load the panel in UXP Developer Tools, unload it there; both use the id `com.local.datamosh`. |

## For developers

You don't need any of the above to work on the panel: load `panel/manifest.json` in
**UXP Developer Tools** (Premiere: Settings > Plugins > **Enable developer mode**),
and use **Reload** after edits. Unload it there before using the installed copy.
