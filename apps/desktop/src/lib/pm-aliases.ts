/**
 * The Postman names people type out of habit, with the tp.* name they become. The script editor lists them when `pm.` is typed,
 * each labelled as a Postman compatibility name and inserting the tp.* one: pm.* scripts still run (a Postman import keeps them
 * when asked), but the app's own code is tp.*.
 */
export const PM_ALIASES: ReadonlyArray<{ pm: string; tp: string }> = [
  ...['get', 'set', 'unset', 'has', 'clear'].flatMap((m) => ['environment', 'globals', 'collectionVariables', 'variables'].map((scope) => ({ pm: `pm.${scope}.${m}`, tp: `tp.${scope}.${m}` }))),
  { pm: 'pm.iterationData.get', tp: 'tp.iterationData.get' },
  { pm: 'pm.test', tp: 'tp.test' },
  { pm: 'pm.expect', tp: 'tp.expect' },
  { pm: 'pm.response.json', tp: 'tp.response.json' },
  { pm: 'pm.response.text', tp: 'tp.response.text' },
  { pm: 'pm.response.code', tp: 'tp.response.code' },
  { pm: 'pm.response.status', tp: 'tp.response.status' },
  { pm: 'pm.response.headers', tp: 'tp.response.headers' },
  { pm: 'pm.response.responseTime', tp: 'tp.response.responseTime' },
  { pm: 'pm.response.to.have.status', tp: 'tp.response.to.have.status' },
  { pm: 'pm.request.url', tp: 'tp.request.url' },
  { pm: 'pm.request.headers', tp: 'tp.request.headers' },
  { pm: 'pm.request.body', tp: 'tp.request.body' },
  { pm: 'pm.sendRequest', tp: 'tp.sendRequest' },
  { pm: 'pm.cookies.get', tp: 'tp.cookies.get' },
  { pm: 'pm.info.requestName', tp: 'tp.info.requestName' },
  { pm: 'pm.visualizer.set', tp: 'tp.visualizer.set' },
  { pm: 'pm.execution.setNextRequest', tp: 'tp.execution.setNextRequest' },
];
