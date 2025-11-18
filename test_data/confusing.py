from functools import reduce

def _(s):
    # Nested lambdas, weird comprehension, shadowing, walrus operator
    return ''.join(
        (lambda z: z[::-1])(
            ''.join(
                chr(
                    (lambda c: (c - 3) if c % 2 else (c + 5))(
                        ord(x) ^ (i % 7 or 1)
                    )
                )
                for i, x in enumerate(s)
                if (i := i + 1) or True  # useless but confusing
            )
        )
    )

class M(type):
    # Metaclass abusing __call__
    def __call__(cls, *a, **k):
        return reduce(
            lambda acc, v: acc + v,
            map(
                lambda p: _(
                    ''.join(
                        reversed(
                            ''.join(
                                map(lambda c: chr(ord(c) ^ 0x2A), p)
                            )
                        )
                    )
                ),
                a
            ),
            ''
        )

class Confusing(metaclass=M):
    pass

if __name__ == "__main__":
    # This looks like nonsense
    s = Confusing(
        "m`oo",    # random-looking strings
        "k`n",
        "n`|q"
    )
    print(s)
