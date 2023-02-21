export default function runFileSystemTests({
  crypto,
  newFileApi,
  name,
  expect,
}) {
  describe(name, function () {
    this.timeout(5000);

    let filesApi;
    beforeEach(async () => {
      filesApi = newFileApi();
      await filesApi.remove("/");
    });
    // afterEach(async () => {
    //   await filesApi.remove("/");
    // });

    function mergeChunks(chunks) {
      const size = chunks.reduce((size, chunk) => size += chunk.length, 0);
      const result = new Uint8ClampedArray(size);
      let pos = 0;
      for (let chunk of chunks) {
        result.set(chunk, pos);
        pos += chunk.length;
      }
      return result;
    }

    async function hash(chunks) {
      const data = mergeChunks(chunks);
      const hashBuffer = await crypto.subtle.digest("SHA-1", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0"))
        .join(""); // convert bytes to hex string
      return hashHex;
    }

    async function readFilesInfo(api, path) {
      const result = [];
      for await (let info of api.list(path, { recursive: true })) {
        result.push(info);
      }
      return result;
    }

    async function writeFileContent(api, path, content) {
      await api.write(path, async function* () {
        const textEncoder = new TextEncoder();
        yield textEncoder.encode(content);
      });
    }

    function compareFilesInfo(list, control) {
      try {
        expect(list.length).to.eql(control.length);
        for (let i = 0; i < control.length; i++) {
          const a = list[i];
          const b = control[i];
          expect(a.kind).to.eql(b.kind);
          expect(a.name).to.eql(b.name);
          expect(a.path).to.eql(b.path);
          expect(a.size).to.eql(b.size);
          expect(a.type).to.eql(b.type);
          // const { lastModified, ...fileInfo } = list[i];
          // expect(fileInfo).to.eql(control[i]);
        }
      } catch (error) {
        console.log(
          JSON.stringify(list, null, 2),
          JSON.stringify(control, null, 2),
        );
        throw error;
      }
    }

    it(`should be able to read the root of the file system`, async () => {
      // await writeFileContent(filesApi, "/x", "");
      const list = await readFilesInfo(filesApi, "/");
      compareFilesInfo(list, []);
    });

    it(`should be able to create a new file and read information about it`, async () => {
      await writeFileContent(filesApi, "/a/b/c.txt", "Hello, wonderful world!");

      compareFilesInfo([await filesApi.stats("/a/b/")], [{
        "path": "/a/b",
        "name": "b",
        "kind": "directory",
      }]);
      compareFilesInfo([await filesApi.stats("/a/b/c.txt")], [{
        "path": "/a/b/c.txt",
        "name": "c.txt",
        "kind": "file",
        "size": 23,
        "type": "text/plain",
      }]);

      // Check the info using the list function
      const list = await readFilesInfo(filesApi, "/");
      compareFilesInfo(list, [
        {
          "path": "/a",
          "name": "a",
          "kind": "directory",
        },
        {
          "path": "/a/b",
          "name": "b",
          "kind": "directory",
        },
        {
          "path": "/a/b/c.txt",
          "name": "c.txt",
          "kind": "file",
          "size": 23,
          "type": "text/plain",
          // "lastModified": 1676723522788
        },
      ]);
    });

    it(`should be able to read file content`, async () => {
      const text = "Hello, wonderful world!";
      const filePath = "/a/message.txt";
      await filesApi.write(filePath, async function* () {
        const textEncoder = new TextEncoder();
        yield textEncoder.encode(text);
      });
      const textDecoder = new TextDecoder();
      let result = "";
      for await (let chunk of filesApi.read(filePath)) {
        result += textDecoder.decode(chunk);
      }
      expect(result).to.eql(text);
    });

    it(`should be able to rename file`, async () => {
      const text = "Hello, wonderful world!";
      const filePath = "/a/message.txt";
      await writeFileContent(filesApi, filePath, text);
      await filesApi.move("/a/message.txt", "/a/MyNewMessage.txt");
      const list = await readFilesInfo(filesApi, "/");
      compareFilesInfo(list, [
        {
          "path": "/a",
          "name": "a",
          "kind": "directory",
        },
        {
          "path": "/a/MyNewMessage.txt",
          "name": "MyNewMessage.txt",
          "kind": "file",
          "size": 23,
          "type": "text/plain",
        },
      ]);
    });

    it(`should be able to rename folders`, async () => {
      const text = "Hello, wonderful world!";
      const filePath = "/a/b/c/message.txt";
      await writeFileContent(filesApi, filePath, text);
      await filesApi.move("/a", "/B");
      const list = await readFilesInfo(filesApi, "/");
      compareFilesInfo(list, [
        {
          "path": "/B",
          "name": "B",
          "kind": "directory",
        },
        {
          "path": "/B/b",
          "name": "b",
          "kind": "directory",
        },
        {
          "path": "/B/b/c",
          "name": "c",
          "kind": "directory",
        },
        {
          "path": "/B/b/c/message.txt",
          "name": "message.txt",
          "kind": "file",
          "size": 23,
          "type": "text/plain",
        },
      ]);
    });

    it(`should be able to write and read "big" files`, async () => {
      let sourceDigest;
      const fullSize = 1024 * 1024 * 16;
      const maxChunkSize = 1024 * 32;
      const minChunkSize = 16;
      await filesApi.write("/a/b/my-data.bin", async function* () {
        const chunks = [];
        for (let size = 0, chunkSize = 0; size < fullSize; size += chunkSize) {
          chunkSize = Math.round(
            minChunkSize + Math.random() * (maxChunkSize - minChunkSize),
          );
          chunkSize = Math.min(chunkSize, fullSize - size);
          const chunk = crypto.getRandomValues(
            new Uint8ClampedArray(chunkSize),
          );
          yield chunk;
          chunks.push(chunk);
        }
        sourceDigest = await hash(chunks);
      });

      const chunks = [];
      for await (const chunk of filesApi.read("/a/b/my-data.bin")) {
        chunks.push(chunk);
      }
      const resultDigest = await hash(chunks);
      expect(resultDigest).to.eql(sourceDigest);
    });
  });
}
