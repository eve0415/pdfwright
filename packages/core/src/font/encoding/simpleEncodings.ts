/** Glyph names by character code: index `code` holds the name the encoding gives code `code`, or undefined where it gives none. */
export type EncodingTable = readonly (string | undefined)[];

// ISO 32000-1:2008, Annex D, D.2 "Latin Character Set and Encodings", one row per character: its name and its codes in StandardEncoding, MacRomanEncoding, WinAnsiEncoding and PDFDocEncoding, in octal as the table prints them, "-" where the encoding has none.
const LATIN = `A 101 101 101 101
AE 341 256 306 306
Aacute - 347 301 301
Acircumflex - 345 302 302
Adieresis - 200 304 304
Agrave - 313 300 300
Aring - 201 305 305
Atilde - 314 303 303
B 102 102 102 102
C 103 103 103 103
Ccedilla - 202 307 307
D 104 104 104 104
E 105 105 105 105
Eacute - 203 311 311
Ecircumflex - 346 312 312
Edieresis - 350 313 313
Egrave - 351 310 310
Eth - - 320 320
Euro - - 200 240
F 106 106 106 106
G 107 107 107 107
H 110 110 110 110
I 111 111 111 111
Iacute - 352 315 315
Icircumflex - 353 316 316
Idieresis - 354 317 317
Igrave - 355 314 314
J 112 112 112 112
K 113 113 113 113
L 114 114 114 114
Lslash 350 - - 225
M 115 115 115 115
N 116 116 116 116
Ntilde - 204 321 321
O 117 117 117 117
OE 352 316 214 226
Oacute - 356 323 323
Ocircumflex - 357 324 324
Odieresis - 205 326 326
Ograve - 361 322 322
Oslash 351 257 330 330
Otilde - 315 325 325
P 120 120 120 120
Q 121 121 121 121
R 122 122 122 122
S 123 123 123 123
Scaron - - 212 227
T 124 124 124 124
Thorn - - 336 336
U 125 125 125 125
Uacute - 362 332 332
Ucircumflex - 363 333 333
Udieresis - 206 334 334
Ugrave - 364 331 331
V 126 126 126 126
W 127 127 127 127
X 130 130 130 130
Y 131 131 131 131
Yacute - - 335 335
Ydieresis - 331 237 230
Z 132 132 132 132
Zcaron - - 216 231
a 141 141 141 141
aacute - 207 341 341
acircumflex - 211 342 342
acute 302 253 264 264
adieresis - 212 344 344
ae 361 276 346 346
agrave - 210 340 340
ampersand 046 046 046 046
aring - 214 345 345
asciicircum 136 136 136 136
asciitilde 176 176 176 176
asterisk 052 052 052 052
at 100 100 100 100
atilde - 213 343 343
b 142 142 142 142
backslash 134 134 134 134
bar 174 174 174 174
braceleft 173 173 173 173
braceright 175 175 175 175
bracketleft 133 133 133 133
bracketright 135 135 135 135
breve 306 371 - 030
brokenbar - - 246 246
bullet 267 245 225 200
c 143 143 143 143
caron 317 377 - 031
ccedilla - 215 347 347
cedilla 313 374 270 270
cent 242 242 242 242
circumflex 303 366 210 032
colon 072 072 072 072
comma 054 054 054 054
copyright - 251 251 251
currency 250 333 244 244
d 144 144 144 144
dagger 262 240 206 201
daggerdbl 263 340 207 202
degree - 241 260 260
dieresis 310 254 250 250
divide - 326 367 367
dollar 044 044 044 044
dotaccent 307 372 - 033
dotlessi 365 365 - 232
e 145 145 145 145
eacute - 216 351 351
ecircumflex - 220 352 352
edieresis - 221 353 353
egrave - 217 350 350
eight 070 070 070 070
ellipsis 274 311 205 203
emdash 320 321 227 204
endash 261 320 226 205
equal 075 075 075 075
eth - - 360 360
exclam 041 041 041 041
exclamdown 241 301 241 241
f 146 146 146 146
fi 256 336 - 223
five 065 065 065 065
fl 257 337 - 224
florin 246 304 203 206
four 064 064 064 064
fraction 244 332 - 207
g 147 147 147 147
germandbls 373 247 337 337
grave 301 140 140 140
greater 076 076 076 076
guillemotleft 253 307 253 253
guillemotright 273 310 273 273
guilsinglleft 254 334 213 210
guilsinglright 255 335 233 211
h 150 150 150 150
hungarumlaut 315 375 - 034
hyphen 055 055 055 055
i 151 151 151 151
iacute - 222 355 355
icircumflex - 224 356 356
idieresis - 225 357 357
igrave - 223 354 354
j 152 152 152 152
k 153 153 153 153
l 154 154 154 154
less 074 074 074 074
logicalnot - 302 254 254
lslash 370 - - 233
m 155 155 155 155
macron 305 370 257 257
minus - - - 212
mu - 265 265 265
multiply - - 327 327
n 156 156 156 156
nine 071 071 071 071
ntilde - 226 361 361
numbersign 043 043 043 043
o 157 157 157 157
oacute - 227 363 363
ocircumflex - 231 364 364
odieresis - 232 366 366
oe 372 317 234 234
ogonek 316 376 - 035
ograve - 230 362 362
one 061 061 061 061
onehalf - - 275 275
onequarter - - 274 274
onesuperior - - 271 271
ordfeminine 343 273 252 252
ordmasculine 353 274 272 272
oslash 371 277 370 370
otilde - 233 365 365
p 160 160 160 160
paragraph 266 246 266 266
parenleft 050 050 050 050
parenright 051 051 051 051
percent 045 045 045 045
period 056 056 056 056
periodcentered 264 341 267 267
perthousand 275 344 211 213
plus 053 053 053 053
plusminus - 261 261 261
q 161 161 161 161
question 077 077 077 077
questiondown 277 300 277 277
quotedbl 042 042 042 042
quotedblbase 271 343 204 214
quotedblleft 252 322 223 215
quotedblright 272 323 224 216
quoteleft 140 324 221 217
quoteright 047 325 222 220
quotesinglbase 270 342 202 221
quotesingle 251 047 047 047
r 162 162 162 162
registered - 250 256 256
ring 312 373 - 036
s 163 163 163 163
scaron - - 232 235
section 247 244 247 247
semicolon 073 073 073 073
seven 067 067 067 067
six 066 066 066 066
slash 057 057 057 057
space 040 040 040 040
sterling 243 243 243 243
t 164 164 164 164
thorn - - 376 376
three 063 063 063 063
threequarters - - 276 276
threesuperior - - 263 263
tilde 304 367 230 037
trademark - 252 231 222
two 062 062 062 062
twosuperior - - 262 262
u 165 165 165 165
uacute - 234 372 372
ucircumflex - 236 373 373
udieresis - 237 374 374
ugrave - 235 371 371
underscore 137 137 137 137
v 166 166 166 166
w 167 167 167 167
x 170 170 170 170
y 171 171 171 171
yacute - - 375 375
ydieresis - 330 377 377
yen 245 264 245 245
z 172 172 172 172
zcaron - - 236 236
zero 060 060 060 060`;

// D.4 "Expert Set and MacExpertEncoding": each character name and its MacExpertEncoding code, in octal.
const EXPERT = `AEsmall 276
Aacutesmall 207
Acircumflexsmall 211
Acutesmall 047
Adieresissmall 212
Agravesmall 210
Aringsmall 214
Asmall 141
Atildesmall 213
Brevesmall 363
Bsmall 142
Caronsmall 256
Ccedillasmall 215
Cedillasmall 311
Circumflexsmall 136
Csmall 143
Dieresissmall 254
Dotaccentsmall 372
Dsmall 144
Eacutesmall 216
Ecircumflexsmall 220
Edieresissmall 221
Egravesmall 217
Esmall 145
Ethsmall 104
Fsmall 146
Gravesmall 140
Gsmall 147
Hsmall 150
Hungarumlautsmall 042
Iacutesmall 222
Icircumflexsmall 224
Idieresissmall 225
Igravesmall 223
Ismall 151
Jsmall 152
Ksmall 153
Lslashsmall 302
Lsmall 154
Macronsmall 364
Msmall 155
Nsmall 156
Ntildesmall 226
OEsmall 317
Oacutesmall 227
Ocircumflexsmall 231
Odieresissmall 232
Ogoneksmall 362
Ogravesmall 230
Oslashsmall 277
Osmall 157
Otildesmall 233
Psmall 160
Qsmall 161
Ringsmall 373
Rsmall 162
Scaronsmall 247
Ssmall 163
Thornsmall 271
Tildesmall 176
Tsmall 164
Uacutesmall 234
Ucircumflexsmall 236
Udieresissmall 237
Ugravesmall 235
Usmall 165
Vsmall 166
Wsmall 167
Xsmall 170
Yacutesmall 264
Ydieresissmall 330
Ysmall 171
Zcaronsmall 275
Zsmall 172
ampersandsmall 046
asuperior 201
bsuperior 365
centinferior 251
centoldstyle 043
centsuperior 202
colon 072
colonmonetary 173
comma 054
commainferior 262
commasuperior 370
dollarinferior 266
dollaroldstyle 044
dollarsuperior 045
dsuperior 353
eightinferior 245
eightoldstyle 070
eightsuperior 241
esuperior 344
exclamdownsmall 326
exclamsmall 041
ff 126
ffi 131
ffl 132
fi 127
figuredash 320
fiveeighths 114
fiveinferior 260
fiveoldstyle 065
fivesuperior 336
fl 130
fourinferior 242
fouroldstyle 064
foursuperior 335
fraction 057
hyphen 055
hypheninferior 137
hyphensuperior 321
isuperior 351
lsuperior 361
msuperior 367
nineinferior 273
nineoldstyle 071
ninesuperior 341
nsuperior 366
onedotenleader 053
oneeighth 112
onefitted 174
onehalf 110
oneinferior 301
oneoldstyle 061
onequarter 107
onesuperior 332
onethird 116
osuperior 257
parenleftinferior 133
parenleftsuperior 050
parenrightinferior 135
parenrightsuperior 051
period 056
periodinferior 263
periodsuperior 371
questiondownsmall 300
questionsmall 077
rsuperior 345
rupiah 175
semicolon 073
seveneighths 115
seveninferior 246
sevenoldstyle 067
sevensuperior 340
sixinferior 244
sixoldstyle 066
sixsuperior 337
space 040
ssuperior 352
threeeighths 113
threeinferior 243
threeoldstyle 063
threequarters 111
threequartersemdash 075
threesuperior 334
tsuperior 346
twodotenleader 052
twoinferior 252
twooldstyle 062
twosuperior 333
twothirds 117
zeroinferior 274
zerooldstyle 060
zerosuperior 342`;

// D.5 "Symbol Set and Encoding": each character name and its code in the Symbol font's built-in encoding, in octal.
const SYMBOL = `Alpha 101
Beta 102
Chi 103
Delta 104
Epsilon 105
Eta 110
Euro 240
Gamma 107
Ifraktur 301
Iota 111
Kappa 113
Lambda 114
Mu 115
Nu 116
Omega 127
Omicron 117
Phi 106
Pi 120
Psi 131
Rfraktur 302
Rho 122
Sigma 123
Tau 124
Theta 121
Upsilon 125
Upsilon1 241
Xi 130
Zeta 132
aleph 300
alpha 141
ampersand 046
angle 320
angleleft 341
angleright 361
approxequal 273
arrowboth 253
arrowdblboth 333
arrowdbldown 337
arrowdblleft 334
arrowdblright 336
arrowdblup 335
arrowdown 257
arrowhorizex 276
arrowleft 254
arrowright 256
arrowup 255
arrowvertex 275
asteriskmath 052
bar 174
beta 142
braceex 357
braceleft 173
braceleftbt 356
braceleftmid 355
bracelefttp 354
braceright 175
bracerightbt 376
bracerightmid 375
bracerighttp 374
bracketleft 133
bracketleftbt 353
bracketleftex 352
bracketlefttp 351
bracketright 135
bracketrightbt 373
bracketrightex 372
bracketrighttp 371
bullet 267
carriagereturn 277
chi 143
circlemultiply 304
circleplus 305
club 247
colon 072
comma 054
congruent 100
copyrightsans 343
copyrightserif 323
degree 260
delta 144
diamond 250
divide 270
dotmath 327
eight 070
element 316
ellipsis 274
emptyset 306
epsilon 145
equal 075
equivalence 272
eta 150
exclam 041
existential 044
five 065
florin 246
four 064
fraction 244
gamma 147
gradient 321
greater 076
greaterequal 263
heart 251
infinity 245
integral 362
integralbt 365
integralex 364
integraltp 363
intersection 307
iota 151
kappa 153
lambda 154
less 074
lessequal 243
logicaland 331
logicalnot 330
logicalor 332
lozenge 340
minus 055
minute 242
mu 155
multiply 264
nine 071
notelement 317
notequal 271
notsubset 313
nu 156
numbersign 043
omega 167
omega1 166
omicron 157
one 061
parenleft 050
parenleftbt 350
parenleftex 347
parenlefttp 346
parenright 051
parenrightbt 370
parenrightex 367
parenrighttp 366
partialdiff 266
percent 045
period 056
perpendicular 136
phi 146
phi1 152
pi 160
plus 053
plusminus 261
product 325
propersubset 314
propersuperset 311
proportional 265
psi 171
question 077
radical 326
radicalex 140
reflexsubset 315
reflexsuperset 312
registersans 342
registerserif 322
rho 162
second 262
semicolon 073
seven 067
sigma 163
sigma1 126
similar 176
six 066
slash 057
space 040
spade 252
suchthat 047
summation 345
tau 164
therefore 134
theta 161
theta1 112
three 063
trademarksans 344
trademarkserif 324
two 062
underscore 137
union 310
universal 042
upsilon 165
weierstrass 303
xi 170
zero 060
zeta 172`;

// D.6 "ZapfDingbats Set and Encoding": each character name and its code in the ZapfDingbats font's built-in encoding, in octal.
const DINGBATS = `space 040
a1 041
a2 042
a202 043
a3 044
a4 045
a5 046
a119 047
a118 050
a117 051
a11 052
a12 053
a13 054
a14 055
a15 056
a16 057
a105 060
a17 061
a18 062
a19 063
a20 064
a21 065
a22 066
a23 067
a24 070
a25 071
a26 072
a27 073
a28 074
a6 075
a7 076
a8 077
a9 100
a10 101
a29 102
a30 103
a31 104
a32 105
a33 106
a34 107
a35 110
a36 111
a37 112
a38 113
a39 114
a40 115
a41 116
a42 117
a43 120
a44 121
a45 122
a46 123
a47 124
a48 125
a49 126
a50 127
a51 130
a52 131
a53 132
a54 133
a55 134
a56 135
a57 136
a58 137
a59 140
a60 141
a61 142
a62 143
a63 144
a64 145
a65 146
a66 147
a67 150
a68 151
a69 152
a70 153
a71 154
a72 155
a73 156
a74 157
a203 160
a75 161
a204 162
a76 163
a77 164
a78 165
a79 166
a81 167
a82 170
a83 171
a84 172
a97 173
a98 174
a99 175
a100 176
a101 241
a102 242
a103 243
a104 244
a106 245
a107 246
a108 247
a112 250
a111 251
a110 252
a109 253
a120 254
a121 255
a122 256
a123 257
a124 260
a125 261
a126 262
a127 263
a128 264
a129 265
a130 266
a131 267
a132 270
a133 271
a134 272
a135 273
a136 274
a137 275
a138 276
a139 277
a140 300
a141 301
a142 302
a143 303
a144 304
a145 305
a146 306
a147 307
a148 310
a149 311
a150 312
a151 313
a152 314
a153 315
a154 316
a155 317
a156 320
a157 321
a158 322
a159 323
a160 324
a161 325
a163 326
a164 327
a196 330
a165 331
a192 332
a166 333
a167 334
a168 335
a169 336
a170 337
a171 340
a172 341
a173 342
a162 343
a174 344
a175 345
a176 346
a177 347
a178 350
a179 351
a193 352
a180 353
a199 354
a181 355
a200 356
a182 357
a201 361
a183 362
a184 363
a197 364
a185 365
a194 366
a198 367
a186 370
a195 371
a187 372
a188 373
a189 374
a190 375
a191 376`;

const rows = (table: string): string[][] => table.split('\n').map(row => row.split(' '));

const tableOf = (entries: readonly (readonly [string, string | undefined])[]): EncodingTable => {
  const names: (string | undefined)[] = Array.from<string | undefined>({ length: 256 });
  for (const [name, octal] of entries) if (octal !== undefined && octal !== '-') names[Number.parseInt(octal, 8)] = name;
  return names;
};

const latinColumn = (column: number): (string | undefined)[] => [...tableOf(rows(LATIN).map(([name = '', ...codes]) => [name, codes[column]]))];

/** StandardEncoding, the built-in encoding of Adobe's Latin-text Type 1 fonts (D.2). */
export const STANDARD_ENCODING: EncodingTable = latinColumn(0);

/** MacRomanEncoding (D.2); footnote 6: "The SPACE character shall also be encoded as 312 in MacRomanEncoding". */
export const MAC_ROMAN_ENCODING: EncodingTable = ((): EncodingTable => {
  const names = latinColumn(1);
  names[0o312] = 'space';
  return names;
})();

/**
 * WinAnsiEncoding (D.2) with the codes its footnotes add: footnote 3, "In WinAnsiEncoding, all unused codes greater than 40 map to the bullet character"; footnote 5, "The hyphen character is also encoded as 255 in WinAnsiEncoding"; footnote 6, the space "as 240 in WinAnsiEncoding".
 */
export const WIN_ANSI_ENCODING: EncodingTable = ((): EncodingTable => {
  const names = latinColumn(2);
  names[0o240] = 'space';
  names[0o255] = 'hyphen';
  for (let code = 0o41; code < 256; code++) names[code] ??= 'bullet';
  return names;
})();

/** The Latin character names by their PDFDocEncoding codes (D.2). */
export const PDF_DOC_ENCODING: EncodingTable = latinColumn(3);

/** MacExpertEncoding (D.4). */
export const MAC_EXPERT_ENCODING: EncodingTable = tableOf(rows(EXPERT).map(([name = '', octal]) => [name, octal]));

/** The built-in encoding of the standard Symbol font (D.5). */
export const SYMBOL_ENCODING: EncodingTable = tableOf(rows(SYMBOL).map(([name = '', octal]) => [name, octal]));

/** The built-in encoding of the standard ZapfDingbats font (D.6). */
export const ZAPF_DINGBATS_ENCODING: EncodingTable = tableOf(rows(DINGBATS).map(([name = '', octal]) => [name, octal]));

/** Each Latin character name of D.2 with its PDFDocEncoding code; every row of D.2 has one. */
export const LATIN_PDF_DOC_CODES: ReadonlyMap<string, number> = new Map(rows(LATIN).map(([name = '', ...codes]) => [name, Number.parseInt(codes[3] ?? '', 8)]));

// D.3, Table D.2 "PDFDocEncoding Character Set": the codes whose Unicode value differs from the code, as code and Unicode value in hexadecimal.
const PDF_DOC_DIFFERENCES: ReadonlyMap<number, number> = new Map(
  '18:02D8 19:02C7 1A:02C6 1B:02D9 1C:02DD 1D:02DB 1E:02DA 1F:02DC 80:2022 81:2020 82:2021 83:2026 84:2014 85:2013 86:0192 87:2044 88:2039 89:203A 8A:2212 8B:2030 8C:201E 8D:201C 8E:201D 8F:2018 90:2019 91:201A 92:2122 93:FB01 94:FB02 95:0141 96:0152 97:0160 98:0178 99:017D 9A:0131 9B:0142 9C:0153 9D:0161 9E:017E A0:20AC'
    .split(' ')
    .map(pair => {
      const [code = '', unicode = ''] = pair.split(':');
      return [Number.parseInt(code, 16), Number.parseInt(unicode, 16)];
    }),
);

/** The Unicode value of a PDFDocEncoding code (D.3), or undefined for the codes Table D.2 marks "Undefined code point in PDFDocEncoding": 0–8, 11, 12, 14–23, 127, 159 and 173. */
export const pdfDocEncodingUnicode = (code: number): number | undefined => {
  if (code < 0 || code > 255 || code === 0x7f || code === 0x9f || code === 0xad) return undefined;
  if (code < 0x18 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return undefined;
  return PDF_DOC_DIFFERENCES.get(code) ?? code;
};

/** The encoding a font's Encoding or BaseEncoding name selects: MacRomanEncoding, MacExpertEncoding or WinAnsiEncoding (ISO 32000-1:2008, Table 114), or undefined for any other name. */
export const namedEncoding = (name: string): EncodingTable | undefined => {
  switch (name) {
    case 'MacRomanEncoding': {
      return MAC_ROMAN_ENCODING;
    }
    case 'WinAnsiEncoding': {
      return WIN_ANSI_ENCODING;
    }
    case 'MacExpertEncoding': {
      return MAC_EXPERT_ENCODING;
    }
    default: {
      return undefined;
    }
  }
};
