---
title: "Script packages"
description: "Shared modules for scripts: write the code once, load it with tp.require from any request, test or monitor, and keep it in the workspace with git."
---

# Script packages

A **script package** is a piece of script code shared by many requests: signing a request, refreshing a token, a set of checks you repeat. Write it once as a package and load it from any script with `tp.require`. It works like the package library of Postman.

## Make one

1. Open **Scripts ▸ Packages…** in a request.
2. Choose **New package** and give it a name: `utils`, or a scoped name such as `@team/auth`. Letters, digits, `.`, `_` and `-` are fine.
3. Write the code. A package is a CommonJS module: put what it offers on `module.exports`.
4. **Save**.

```js
// the package "@team/auth"
module.exports = {
  bearer(token) {
    return 'Bearer ' + token;
  },
};
```

## Use it

```js
const auth = tp.require('@team/auth');
tp.request.headers.upsert({ key: 'Authorization', value: auth.bearer(tp.environment.get('token')) });
```

A package can `tp.require` other packages and `require()` the built-in modules of the script sandbox. Each package is loaded once per script run. A Postman collection whose scripts use packages runs once the packages are added here with the same names.

## Where it lives

Each package is a file in the workspace, `packages/<name>.js`, so it travels with the workspace in git and in an exported bundle (**Export with everything it uses…** includes the packages a collection loads). The CLI and the MCP server run the same code from the same folder.

## Changing and deleting

Edit a package and save it: every script that loads it uses the new code on its next run. **Delete** removes the file for good, so it asks first, and scripts that still `tp.require` it fail with a message that names the missing package.

## See also

- [REST and HTTP](/api-testing/rest#scripts): the scripts of a request.
- [Collections and import](/api-testing/collections): what an import does with Postman packages.
- [Privacy and security](/security/privacy): what scripts are allowed to read and send.
