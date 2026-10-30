@echo off
rem Deploys Hawkes Gen to the cloud (hawkesgen.ai) from this PC, without GitHub Actions: typecheck and tests on a
rem clean copy of main, push, then the server deploys that commit. hawkesstudio\deploy\local-deploy.mjs does the work.
rem   auto-deploy.bat               check, push, deploy
rem   auto-deploy.bat --skip-tests  typecheck only (when you are sure)
cd /d "%~dp0"
title Deploy Hawkes Gen
node --disable-warning=ExperimentalWarning "%~dp0..\hawkesstudio\deploy\local-deploy.mjs" hawkesgen %*
pause
