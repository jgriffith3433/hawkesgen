// Loaded before every test file (package.json "test": --import). The tests are J's PC: the checks that run them may
// themselves be on Cloud Run, where K_SERVICE is set and would turn off the local owner (auth.ts localOpen) and change
// other Cloud Run-only paths. Tests that want Cloud Run set K_SERVICE themselves.
delete process.env.K_SERVICE;
delete process.env.K_REVISION;
delete process.env.K_CONFIGURATION;
