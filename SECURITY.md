# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Email the maintainers through the contact on the [Formicaria GitHub organisation](https://github.com/Formicaria) with a description and, if possible, a reproduction. You will get an acknowledgement within a few days.

## What RepoScope does with repositories

- Public GitHub repositories are shallow-cloned into a temporary directory, analysed, and deleted immediately afterwards.
- Uploaded folders are read in the browser; `node_modules`, `.git`, build output and binaries are filtered before anything is sent. Only text files up to 256 KB are transmitted.
- Files that look like they carry secrets (`.env*`, private keys, credential files) are recorded by name and never read.
- Secret patterns found in source files are reported by file and line; the matched value is never stored, exported or displayed.
- Results are held in the API process's memory (capped) and in the user's own `localStorage`. Nothing is written to disk on the server.
- No analytics, no third-party calls other than GitHub (metadata + clone) and, only if explicitly configured, the user's own LLM endpoint.

## Running it safely

RepoScope is designed to run locally or on an internal host. If you expose it publicly, put it behind authentication and a rate limit: scanning is CPU- and network-intensive, and the upload endpoint accepts up to 60 MB of JSON.
