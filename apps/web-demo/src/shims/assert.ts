type AssertLike = ((value: unknown, message?: string) => asserts value) & {
  ok: (value: unknown, message?: string) => asserts value;
};

const assertShim = ((value: unknown, message?: string) => {
  if (!value) {
    throw new Error(message ?? "Assertion failed");
  }
}) as AssertLike;

assertShim.ok = assertShim;

export default assertShim;
