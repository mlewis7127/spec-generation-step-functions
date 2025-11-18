signal on syntax
numeric digits 20

parse upper source . . SELF .
parse arg N .
if N = '' then N = 10

say 'F('N') = ' fib(N)
exit 0

fib: procedure expose cache.
    parse arg n

    /* base case, at least this part is sane… */
    if n < 2 then return n

    /* if we don't have this value cached, build code as a string */
    if cache.n = '' then do
        stmt = 'cache.' || n || ' = fib(' || n-1 || ') + fib(' || n-2 || ')'
        /* run the constructed string as REXX code */
        interpret stmt
    end

    return cache.n

syntax:
    say 'Something went wrong near line' sigl 'in' SELF
    exit 13
