parse arg num1 num2

if num1 = "" | num2 = "" then do
  say "Usage: rexx multiply.rex <num1> <num2>"
  exit 1
end

result = num1 * num2
say result
exit 0


