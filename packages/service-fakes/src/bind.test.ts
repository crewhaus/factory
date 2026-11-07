/**
 * Every fake listens on loopback, by what the operating system says rather than
 * by fetching the address: a fetch to the address it bound cannot tell loopback
 * from a wildcard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { listeningAddresses, parseLsofListeners, parseSsListeners } from "./bind-check";
import { fakeGitHub } from "./github";
import { fakeModel } from "./model";
import type { FakeService } from "./serve";
import { fakeSlack } from "./slack";
import { fakeSmtp } from "./smtp";
import { fakeThredz } from "./thredz";

const running: FakeService[] = [];
afterEach(async () => {
  while (running.length > 0) await (running.pop() as FakeService).stop();
});

describe("the operating system sees each fake on 127.0.0.1 only", () => {
  test.each([
    ["fakeModel", () => fakeModel()],
    ["fakeSlack", () => fakeSlack()],
    ["fakeGitHub", () => fakeGitHub()],
    ["fakeThredz", () => fakeThredz()],
    ["fakeSmtp", () => fakeSmtp()],
  ] as const)("%s", (_name, start) => {
    const fake = start();
    running.push(fake);
    expect(fake.port).toBeGreaterThan(0);
    // `undefined` (could not determine) fails here too: it is not a pass.
    expect(listeningAddresses(process.pid, fake.port)).toEqual(["127.0.0.1"]);
  });
});

describe("the parsers, on recorded output", () => {
  test("lsof: a loopback listener", () => {
    const output = "p4242\nf17\nn127.0.0.1:53211\n";
    expect(parseLsofListeners(output, 53211)).toEqual(["127.0.0.1"]);
  });

  test("lsof: a wildcard listener is reported, not hidden", () => {
    const output = "p4242\nf17\nn*:53211\n";
    expect(parseLsofListeners(output, 53211)).toEqual(["*"]);
  });

  test("lsof: both a loopback and an IPv6 listener are reported", () => {
    const output = "p4242\nf17\nn127.0.0.1:53211\nf18\nn[::1]:53211\n";
    expect(parseLsofListeners(output, 53211)).toEqual(["127.0.0.1", "::1"]);
  });

  test("lsof: another port does not count", () => {
    expect(parseLsofListeners("p1\nf1\nn127.0.0.1:9\n", 53211)).toEqual([]);
  });

  const SS = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    'LISTEN 0      512        127.0.0.1:46033      0.0.0.0:*    users:(("bun",pid=2121,fd=15))',
    'LISTEN 0      512                *:46034            *:*    users:(("bun",pid=2121,fd=16))',
    'LISTEN 0      4096            [::]:46035         [::]:*    users:(("bun",pid=2121,fd=17))',
    'LISTEN 0      512        127.0.0.1:46036      0.0.0.0:*    users:(("sshd",pid=99,fd=3))',
    'LISTEN 0      512        127.0.0.1:46037      0.0.0.0:*    users:(("bun",pid=21210,fd=3))',
    "",
  ].join("\n");

  test("ss: a loopback listener", () => {
    expect(parseSsListeners(SS, 2121, 46033)).toEqual(["127.0.0.1"]);
  });

  test("ss: a wildcard listener is reported, in both spellings", () => {
    expect(parseSsListeners(SS, 2121, 46034)).toEqual(["*"]);
    expect(parseSsListeners(SS, 2121, 46035)).toEqual(["::"]);
  });

  test("ss: another process's listener does not count, nor a pid it is a prefix of", () => {
    expect(parseSsListeners(SS, 2121, 46036)).toEqual([]);
    expect(parseSsListeners(SS, 2121, 46037)).toEqual([]);
  });
});

describe("could not determine", () => {
  test("a port nothing listens on is undefined, not an empty answer", () => {
    expect(listeningAddresses(process.pid, 1)).toBeUndefined();
  });
});
