A React-style frontend and a FastAPI backend with no package.json at the top (e2e/python.spec.ts).

`backend/.venv` is a stand-in virtualenv: `pyvenv.cfg` marks it, and its `python` (bin/ on macOS and Linux,
Scripts/python.cmd on Windows) is a Node script that prints its arguments and whether VIRTUAL_ENV is set,
then keeps running. NestBox puts the virtualenv first on PATH, so no real Python is needed.
