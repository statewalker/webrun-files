export default function addFilesApiLogger({
  filesApi,
  log = console.log,
  wrapper = {},
}) {
  return ["list", "stats", "remove", "write", "read", "copy", "move"].reduce(
    (wrapper, methodName) => {
      const method = filesApi[methodName].bind(filesApi);
      wrapper[methodName] = (...args) => {
        let message = { method: methodName, stage : "enter", args };
        try {
          log(message);
          return message.result = method.call(filesApi, ...args);
        } catch (e) {
          message.error = e;
        } finally {
          message.stage = "exit";
          log(message);
        }
      };
      return wrapper;
    },
    wrapper,
  );
}
