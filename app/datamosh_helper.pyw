"""
Datamosh helper, windowless.

Runs the helper (mosh_server.py) with no console window: double-click this file, or
let install-helper.bat start it with Windows. Messages go to helper.log next to this file.
uninstall.bat stops it.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG = HERE / "helper.log"

# Keep the log small: start fresh once it passes 1 MB.
try:
    if LOG.exists() and LOG.stat().st_size > 1_000_000:
        LOG.unlink()
except OSError:
    pass

log = open(LOG, "a", buffering=1, encoding="utf-8")
sys.stdout = sys.stderr = log
os.chdir(HERE)
sys.path.insert(0, str(HERE))

from datetime import datetime  # noqa: E402

print(f"--- {datetime.now():%Y-%m-%d %H:%M:%S} starting")
import mosh_server  # noqa: E402

try:
    mosh_server.main()
except Exception as e:  # make crashes visible in the log
    import traceback
    traceback.print_exc()
    print(f"helper stopped: {e}")
