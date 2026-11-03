import { describe, expect, it } from "vitest";

import { batchArgumentRefusal, isBatchProgram } from "../protocol.js";

/**
 * The refusal is one pure function, so it says the same thing on every OS. The
 * character set and the list of spellings were measured against cmd.exe through
 * the 0.4.0 helper, not taken from a document: `test/live/lookup.live.mjs` is
 * where each of them is shown to reach cmd.exe.
 */
describe("isBatchProgram", () => {
    const spellings = [
        "x.cmd",
        "x.bat",
        "X.CMD",
        "x.Bat",
        "x.cMd",
        // Windows strips these, so each of them runs x.cmd.
        "x.cmd.",
        "x.cmd...",
        "x.cmd ",
        "x.cmd   ",
        "x.cmd .",
        "x.cmd. ",
        "x.bat.",
        // Path normalisation gets to the same file. Measured: all of these run it.
        "C:\\d\\x.cmd",
        "C:/d/x.cmd",
        "C:\\d\\x.cmd\\.",
        "C:\\d\\x.cmd/.",
        "C:\\d\\x.cmd\\y\\..",
        "C:\\d\\x.cmd/y/..",
        "C:\\d\\x.cmd\\y\\z\\..\\..",
        "C:\\d\\x.cmd .\\y\\..",
        "C:\\d\\x.cmd. \\.",
        "C:\\d\\y\\..\\x.cmd",
        ".\\x.cmd",
        "sub\\x.cmd",
        "C:x.cmd",
        "\\\\?\\C:\\d\\x.cmd",
        "\\\\.\\C:\\d\\x.cmd",
        "\\\\server\\share\\x.cmd",
        // A short name: other.cmdx is OTHER~1.CMD, and it runs as a batch file.
        "OTHER~1.CMD",
        // POSIX spellings, for the same answer on every OS.
        "./x.cmd",
        "/usr/local/bin/x.cmd",
    ];
    it.each(spellings)("%j is a batch file", (program) => {
        expect(isBatchProgram(program)).toBe(true);
    });

    const others = [
        "cmd.exe",
        "cmd",
        "npm",
        "x.sh",
        "x.cmdx",
        "x.cmd.exe",
        "x.bat.txt",
        "xcmd",
        "cmd",
        "bat",
        ".",
        "",
        "C:\\d.cmd\\real.exe",
        "C:\\d\\x.cmd\\..\\real.exe",
        "/opt/d.bat/tool",
    ];
    it.each(others)("%j is not", (program) => {
        expect(isBatchProgram(program)).toBe(false);
    });
});

describe("batchArgumentRefusal", () => {
    const refused = [
        ["&", "a&b"],
        ["|", "a|b"],
        ["<", "a<b"],
        [">", "a>b"],
        ["^", "a^b"],
        ["%", "%PATH%"],
        ['"', 'a"b'],
        ["!", "!PATH!"],
    ];
    it.each(refused)("refuses %s", (char, arg) => {
        const why = batchArgumentRefusal(["x.cmd", arg]);
        expect(why).toContain(`contains "${char}"`);
    });

    it("refuses a line feed and a carriage return, by name", () => {
        expect(batchArgumentRefusal(["x.cmd", "a\nb"])).toContain("a line feed");
        expect(batchArgumentRefusal(["x.cmd", "a\rb"])).toContain("a carriage return");
    });

    it("refuses the character inside an argument that would be quoted", () => {
        // Safe on the /c line, and live again the moment a script says %~1.
        expect(batchArgumentRefusal(["x.cmd", "a b&c"])).toContain('contains "&"');
    });

    it("names the position of the first argument at fault, counting from argv[0]", () => {
        const why = batchArgumentRefusal(["x.cmd", "fine", "also fine", "a&b", "c|d"]);
        expect(why).toContain("argv[3]");
        expect(why).not.toContain("argv[4]");
    });

    it("says why and what to do", () => {
        const why = batchArgumentRefusal(["x.cmd", "a&b"]);
        expect(why).toMatch(/^fancy-pty: refusing to start the batch file "x\.cmd"/);
        expect(why).toContain("cmd.exe");
        expect(why).toContain("windowsVerbatimArguments");
        expect(why).toContain("every OS");
    });

    it("truncates the argument, and never prints a control character", () => {
        const secret = "abcdefghijkl-mnopqrstuvwxyz-&-TAIL";
        const why = batchArgumentRefusal(["x.cmd", secret])!;
        expect(why).toContain('"abcdefghijkl..."');
        expect(why).not.toContain("mnopqrstuvwxyz");
        expect(why).not.toContain("TAIL");

        const raw = batchArgumentRefusal(["x.cmd", "a\u001b]0;x\nb"])!;
        expect(raw).toContain('"a?]0;x?b"');
        expect(raw).not.toMatch(/[\u0000-\u001f]/);
    });

    it("truncates a long program name, too", () => {
        const why = batchArgumentRefusal([`${"d".repeat(300)}\\x.cmd`, "a&b"])!;
        expect(why.length).toBeLessThan(600);
        expect(why).not.toContain("d".repeat(61));
    });

    const plain = [
        ["--version"],
        ["install"],
        ["a b", "c"],
        ["C:\\Program Files\\x y\\file.txt"],
        ["key=value", "a,b", "a;b", "a(b)c"],
        ["a b\\"],
        ["caf\u00e9"],
        [""],
        ["\uff06", "\uff5c"],
        [],
    ];
    it.each(plain.map((p) => [p]))("lets plain arguments through: %j", (args) => {
        expect(batchArgumentRefusal(["npm.cmd", ...args])).toBeNull();
    });

    it("does not judge the program's own characters, which Windows quotes", () => {
        expect(batchArgumentRefusal(["C:\\R&D tools (x86)\\x.cmd", "plain"])).toBeNull();
    });

    it("leaves verbatim mode alone: the caller owns the quoting there", () => {
        expect(batchArgumentRefusal(["x.cmd", "a&b"], true)).toBeNull();
        expect(batchArgumentRefusal(["x.cmd", '"a b"', "%X%"], true)).toBeNull();
    });

    it("leaves a program that is not a batch file alone", () => {
        expect(batchArgumentRefusal(["tool.exe", "a&b"])).toBeNull();
        expect(batchArgumentRefusal(["./x.sh", "a&b"])).toBeNull();
        expect(batchArgumentRefusal(["cmd.exe", "/c", "a&b"])).toBeNull();
    });
});
