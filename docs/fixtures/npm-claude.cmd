@ECHO off
SET dp0=%~dp0
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
