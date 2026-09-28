# qpdf test files

These files are from `qpdf/qtest/qpdf/` in https://github.com/qpdf/qpdf at commit `4eba95899886e851cc41d76886483b347612f2a8`.
qpdf is licensed under the Apache License 2.0 (https://github.com/qpdf/qpdf/blob/4eba95899886e851cc41d76886483b347612f2a8/LICENSE.txt), and `NOTICE` is qpdf's `NOTICE.md` from the same commit.
They cover cross-reference streams, object streams, a hybrid file, incremental updates, linearized files, damaged cross-reference data and two encrypted files.

| File                              | Bytes | SHA-256                                                            | `qpdf 12.2.0 --check` exit | Encrypted |
| --------------------------------- | ----- | ------------------------------------------------------------------ | -------------------------- | --------- |
| bad-token-startxref.pdf           | 774   | `edcc721a4374c25404985537cdd7618b77ac2ac02a1bad850f4fb59c489a0834` | 0                          | no        |
| bad-xref.pdf                      | 819   | `5895dfedf978f600b12e29643617dbb111869b60526d957878e349571e1467d1` | 3                          | no        |
| bad1.pdf                          | 5     | `fe19778cf1ce280658154f2b9c01ffbccd825a23460141dcf3794e7a2c0eb629` | 2                          | no        |
| compress-objstm-xref.pdf          | 743   | `7aa4aea24328616ce247cc4132efa3b8f53d2844179d17b51383f8771d2de358` | 0                          | no        |
| dangling-bad-xref.pdf             | 1097  | `a6cb86b3a588674544eebdd78523e21c870055267c0a54da39275211b1a0ad2e` | 3                          | no        |
| duplicate-page-inherited.pdf      | 795   | `5ef7073b12f8efe60f132d11a51996a51eb671348298e0364a23264cec2ff0da` | 3                          | no        |
| duplicate-pages.pdf               | 3778  | `c7152ce677a542c38aeaad08fa8ce4b0a098ed15de17eace49bf1ff612b7dee5` | 0                          | no        |
| encrypted-40-bit-R3.pdf           | 1041  | `221b17165d2c807500165c7890f6f8f355b6cf62ecdb430d9bae71cec17b8369` | 2                          | yes       |
| hybrid-xref.pdf                   | 16902 | `df1ae8b9cb2378aaeda6fdc11146dd37328737fd050941390d2c6bd188eea0e4` | 0                          | no        |
| incremental-1.pdf                 | 1423  | `5f9c43d3f201d8e9ea77aa162bf4eb527c563f9db3626a736455e003cf5baaf3` | 0                          | no        |
| incremental-2.pdf                 | 1279  | `4549c92369c3184a382f84eeb4500a4459fbd71409a1aa37e2eb91456dc449e3` | 0                          | no        |
| incremental-3.pdf                 | 944   | `f40a2393e3272a2e037af195570f2339561e1285038cdb501d6881b75c6c7291` | 0                          | no        |
| minimal-linearized.pdf            | 1288  | `75b49e60adac5dd53c07e01c20f488e86c81a12f402c3b1d5b2a5d3e1a7ca883` | 0                          | no        |
| number-tree.pdf                   | 3237  | `5bd9a679bf86685cc32fea7d70d7dc659adb9bd477d485ac5e4960a2b75e9274` | 0                          | no        |
| object-stream.pdf                 | 792   | `7e895514a76bff9c9bb699a14275735c9f5c61415fda7acc1e3e80d3003bc730` | 0                          | no        |
| recover-xref-stream-recovered.pdf | 968   | `2ad98295a599e7fc8d41baaec44ead95b479f433a3e16929002f6ad1734a5a06` | 0                          | no        |
| recover-xref-stream.pdf           | 3817  | `9a78166f8d25c467ac45a39113728043c2a1595e74a39bb697d29565a0e5b2ac` | 3                          | no        |
| reuse-xref-stream.pdf             | 1447  | `0f1648b829578cf04c0d8af2244379156d066c479e2ff3f0fd70e71777af0fe3` | 0                          | no        |
| short-id-linearized.pdf           | 1272  | `d1b2b5834fd8ba103820bd146e61ecb44f5db0c33880f7976e452d34f3eef380` | 0                          | no        |
| V4-aes.pdf                        | 16474 | `1d8a812844b8d8c7ba085a627eb3b7ab52aa651c6143ca07315084220a113240` | 0                          | yes       |
| weird-tokens.pdf                  | 9429  | `1d345d372935656c07f38a6342855f15d6134997d52caeb41bccf6e01a498765` | 0                          | no        |
| xref-with-short-size.pdf          | 16527 | `1b705deb63e4578ae90356463762739cfd2ddbc4ac515800ac7f12c1213710f5` | 3                          | no        |
