DO $migration$
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION 'LCM PostgreSQL schema requires PostgreSQL major version 18'
      USING ERRCODE = 'feature_not_supported';
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
    ) AS privilege
    WHERE namespace.nspname = 'lcm'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION 'LCM PostgreSQL schema refuses PUBLIC CREATE privilege on schema lcm'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$migration$;

CREATE TEXT SEARCH DICTIONARY lcm.simple_v1 (
  TEMPLATE = pg_catalog.simple
);

CREATE TEXT SEARCH CONFIGURATION lcm.search_v1 (
  PARSER = pg_catalog.default
);

ALTER TEXT SEARCH CONFIGURATION lcm.search_v1
  ADD MAPPING FOR
    asciiword, word, numword, email, url, host, sfloat, version,
    hword_numpart, hword_part, hword_asciipart, numhword, asciihword,
    hword, url_path, file, float, int, uint
  WITH lcm.simple_v1;

COMMENT ON TEXT SEARCH CONFIGURATION lcm.search_v1 IS
  'LCM PostgreSQL 18 search configuration; catalog SHA-256 7461327e424809adae678114286199753a7916253ecbb5459a7f1e211b30a568';

CREATE FUNCTION lcm.normalize_search_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
RETURN (
  SELECT COALESCE(
    pg_catalog.string_agg(
      COALESCE($rules${"¡":"!","©":"(C)","ª":"a","«":"<<","­":"-","®":"(R)","±":"+/-","µ":"μ","º":"o","»":">>","¼":" 1/4","½":" 1/2","¾":" 3/4","¿":"?","À":"A","Á":"A","Â":"A","Ã":"A","Ä":"A","Å":"A","Æ":"AE","Ç":"C","È":"E","É":"E","Ê":"E","Ë":"E","Ì":"I","Í":"I","Î":"I","Ï":"I","Ð":"D","Ñ":"N","Ò":"O","Ó":"O","Ô":"O","Õ":"O","Ö":"O","×":"*","Ø":"O","Ù":"U","Ú":"U","Û":"U","Ü":"U","Ý":"Y","Þ":"TH","ß":"ss","à":"a","á":"a","â":"a","ã":"a","ä":"a","å":"a","æ":"ae","ç":"c","è":"e","é":"e","ê":"e","ë":"e","ì":"i","í":"i","î":"i","ï":"i","ð":"d","ñ":"n","ò":"o","ó":"o","ô":"o","õ":"o","ö":"o","÷":"/","ø":"o","ù":"u","ú":"u","û":"u","ü":"u","ý":"y","þ":"th","ÿ":"y","Ā":"A","ā":"a","Ă":"A","ă":"a","Ą":"A","ą":"a","Ć":"C","ć":"c","Ĉ":"C","ĉ":"c","Ċ":"C","ċ":"c","Č":"C","č":"c","Ď":"D","ď":"d","Đ":"D","đ":"d","Ē":"E","ē":"e","Ĕ":"E","ĕ":"e","Ė":"E","ė":"e","Ę":"E","ę":"e","Ě":"E","ě":"e","Ĝ":"G","ĝ":"g","Ğ":"G","ğ":"g","Ġ":"G","ġ":"g","Ģ":"G","ģ":"g","Ĥ":"H","ĥ":"h","Ħ":"H","ħ":"h","Ĩ":"I","ĩ":"i","Ī":"I","ī":"i","Ĭ":"I","ĭ":"i","Į":"I","į":"i","İ":"I","ı":"i","Ĳ":"IJ","ĳ":"ij","Ĵ":"J","ĵ":"j","Ķ":"K","ķ":"k","ĸ":"q","Ĺ":"L","ĺ":"l","Ļ":"L","ļ":"l","Ľ":"L","ľ":"l","Ŀ":"L","ŀ":"l","Ł":"L","ł":"l","Ń":"N","ń":"n","Ņ":"N","ņ":"n","Ň":"N","ň":"n","ŉ":"'n","Ŋ":"N","ŋ":"n","Ō":"O","ō":"o","Ŏ":"O","ŏ":"o","Ő":"O","ő":"o","Œ":"OE","œ":"oe","Ŕ":"R","ŕ":"r","Ŗ":"R","ŗ":"r","Ř":"R","ř":"r","Ś":"S","ś":"s","Ŝ":"S","ŝ":"s","Ş":"S","ş":"s","Š":"S","š":"s","Ţ":"T","ţ":"t","Ť":"T","ť":"t","Ŧ":"T","ŧ":"t","Ũ":"U","ũ":"u","Ū":"U","ū":"u","Ŭ":"U","ŭ":"u","Ů":"U","ů":"u","Ű":"U","ű":"u","Ų":"U","ų":"u","Ŵ":"W","ŵ":"w","Ŷ":"Y","ŷ":"y","Ÿ":"Y","Ź":"Z","ź":"z","Ż":"Z","ż":"z","Ž":"Z","ž":"z","ſ":"s","ƀ":"b","Ɓ":"B","Ƃ":"B","ƃ":"b","Ƈ":"C","ƈ":"c","Ɖ":"D","Ɗ":"D","Ƌ":"D","ƌ":"d","Ɛ":"E","Ƒ":"F","ƒ":"f","Ɠ":"G","ƕ":"hv","Ɩ":"I","Ɨ":"I","Ƙ":"K","ƙ":"k","ƚ":"l","Ɲ":"N","ƞ":"n","Ơ":"O","ơ":"o","Ƣ":"OI","ƣ":"oi","Ƥ":"P","ƥ":"p","ƫ":"t","Ƭ":"T","ƭ":"t","Ʈ":"T","Ư":"U","ư":"u","Ʋ":"V","Ƴ":"Y","ƴ":"y","Ƶ":"Z","ƶ":"z","Ǆ":"DZ","ǅ":"Dz","ǆ":"dz","Ǉ":"LJ","ǈ":"Lj","ǉ":"lj","Ǌ":"NJ","ǋ":"Nj","ǌ":"nj","Ǎ":"A","ǎ":"a","Ǐ":"I","ǐ":"i","Ǒ":"O","ǒ":"o","Ǔ":"U","ǔ":"u","Ǖ":"U","ǖ":"u","Ǘ":"U","ǘ":"u","Ǚ":"U","ǚ":"u","Ǜ":"U","ǜ":"u","Ǟ":"A","ǟ":"a","Ǡ":"A","ǡ":"a","Ǥ":"G","ǥ":"g","Ǧ":"G","ǧ":"g","Ǩ":"K","ǩ":"k","Ǫ":"O","ǫ":"o","Ǭ":"O","ǭ":"o","ǰ":"j","Ǳ":"DZ","ǲ":"Dz","ǳ":"dz","Ǵ":"G","ǵ":"g","Ǹ":"N","ǹ":"n","Ǻ":"A","ǻ":"a","Ȁ":"A","ȁ":"a","Ȃ":"A","ȃ":"a","Ȅ":"E","ȅ":"e","Ȇ":"E","ȇ":"e","Ȉ":"I","ȉ":"i","Ȋ":"I","ȋ":"i","Ȍ":"O","ȍ":"o","Ȏ":"O","ȏ":"o","Ȑ":"R","ȑ":"r","Ȓ":"R","ȓ":"r","Ȕ":"U","ȕ":"u","Ȗ":"U","ȗ":"u","Ș":"S","ș":"s","Ț":"T","ț":"t","Ȟ":"H","ȟ":"h","ȡ":"d","Ȥ":"Z","ȥ":"z","Ȧ":"A","ȧ":"a","Ȩ":"E","ȩ":"e","Ȫ":"O","ȫ":"o","Ȭ":"O","ȭ":"o","Ȯ":"O","ȯ":"o","Ȱ":"O","ȱ":"o","Ȳ":"Y","ȳ":"y","ȴ":"l","ȵ":"n","ȶ":"t","ȷ":"j","ȸ":"db","ȹ":"qp","Ⱥ":"A","Ȼ":"C","ȼ":"c","Ƚ":"L","Ⱦ":"T","ȿ":"s","ɀ":"z","Ƀ":"B","Ʉ":"U","Ɇ":"E","ɇ":"e","Ɉ":"J","ɉ":"j","Ɍ":"R","ɍ":"r","Ɏ":"Y","ɏ":"y","ɓ":"b","ɕ":"c","ɖ":"d","ɗ":"d","ɛ":"e","ɟ":"j","ɠ":"g","ɡ":"g","ɢ":"G","ɦ":"h","ɧ":"h","ɨ":"i","ɪ":"I","ɫ":"l","ɬ":"l","ɭ":"l","ɱ":"m","ɲ":"n","ɳ":"n","ɴ":"N","ɶ":"OE","ɼ":"r","ɽ":"r","ɾ":"r","ʀ":"R","ʂ":"s","ʈ":"t","ʉ":"u","ʋ":"v","ʏ":"Y","ʐ":"z","ʑ":"z","ʙ":"B","ʛ":"G","ʜ":"H","ʝ":"j","ʟ":"L","ʠ":"q","ʣ":"dz","ʥ":"dz","ʦ":"ts","ʪ":"ls","ʫ":"lz","ʰ":"h","ʲ":"j","ʳ":"r","ʷ":"w","ʸ":"y","ʹ":"'","ʺ":"\"","ʻ":"'","ʼ":"'","ʽ":"'","˂":"<","˃":">","˄":"^","ˆ":"^","ˈ":"'","ˋ":"`","ː":":","˖":"+","˗":"-","˜":"~","ˡ":"l","ˢ":"s","ˣ":"x","̀":"","́":"","̂":"","̃":"","̄":"","̅":"","̆":"","̇":"","̈":"","̉":"","̊":"","̋":"","̌":"","̍":"","̎":"","̏":"","̐":"","̑":"","̒":"","̓":"","̔":"","̕":"","̖":"","̗":"","̘":"","̙":"","̚":"","̛":"","̜":"","̝":"","̞":"","̟":"","̠":"","̡":"","̢":"","̣":"","̤":"","̥":"","̦":"","̧":"","̨":"","̩":"","̪":"","̫":"","̬":"","̭":"","̮":"","̯":"","̰":"","̱":"","̲":"","̳":"","̴":"","̵":"","̶":"","̷":"","̸":"","̹":"","̺":"","̻":"","̼":"","̽":"","̾":"","̿":"","̀":"","́":"","͂":"","̓":"","̈́":"","ͅ":"","͆":"","͇":"","͈":"","͉":"","͊":"","͋":"","͌":"","͍":"","͎":"","͏":"","͐":"","͑":"","͒":"","͓":"","͔":"","͕":"","͖":"","͗":"","͘":"","͙":"","͚":"","͛":"","͜":"","͝":"","͞":"","͟":"","͠":"","͡":"","͢":"","Ά":"Α","Έ":"Ε","Ή":"Η","Ί":"Ι","Ό":"Ο","Ύ":"Υ","Ώ":"Ω","ΐ":"ι","Ϊ":"Ι","Ϋ":"Υ","ά":"α","έ":"ε","ή":"η","ί":"ι","ΰ":"υ","ϊ":"ι","ϋ":"υ","ό":"ο","ύ":"υ","ώ":"ω","ϐ":"β","ϑ":"θ","ϒ":"Υ","ϕ":"φ","ϖ":"π","ϰ":"κ","ϱ":"ρ","ϲ":"ς","ϴ":"Θ","ϵ":"ε","Ϲ":"Σ","Ё":"Е","ё":"е","ᴀ":"A","ᴁ":"AE","ᴃ":"B","ᴄ":"C","ᴅ":"D","ᴆ":"D","ᴇ":"E","ᴊ":"J","ᴋ":"K","ᴌ":"L","ᴍ":"M","ᴏ":"O","ᴘ":"P","ᴛ":"T","ᴜ":"U","ᴠ":"V","ᴡ":"W","ᴢ":"Z","ᴬ":"A","ᴮ":"B","ᴰ":"D","ᴱ":"E","ᴳ":"G","ᴴ":"H","ᴵ":"I","ᴶ":"J","ᴷ":"K","ᴸ":"L","ᴹ":"M","ᴺ":"N","ᴼ":"O","ᴾ":"P","ᴿ":"R","ᵀ":"T","ᵁ":"U","ᵂ":"W","ᵃ":"a","ᵇ":"b","ᵈ":"d","ᵉ":"e","ᵍ":"g","ᵏ":"k","ᵐ":"m","ᵒ":"o","ᵖ":"p","ᵗ":"t","ᵘ":"u","ᵛ":"v","ᵝ":"β","ᵞ":"γ","ᵟ":"δ","ᵠ":"φ","ᵡ":"χ","ᵢ":"i","ᵣ":"r","ᵤ":"u","ᵥ":"v","ᵦ":"β","ᵧ":"γ","ᵨ":"ρ","ᵩ":"φ","ᵪ":"χ","ᵫ":"ue","ᵬ":"b","ᵭ":"d","ᵮ":"f","ᵯ":"m","ᵰ":"n","ᵱ":"p","ᵲ":"r","ᵳ":"r","ᵴ":"s","ᵵ":"t","ᵶ":"z","ᵺ":"th","ᵻ":"I","ᵽ":"p","ᵾ":"U","ᶀ":"b","ᶁ":"d","ᶂ":"f","ᶃ":"g","ᶄ":"k","ᶅ":"l","ᶆ":"m","ᶇ":"n","ᶈ":"p","ᶉ":"r","ᶊ":"s","ᶌ":"v","ᶍ":"x","ᶎ":"z","ᶏ":"a","ᶑ":"d","ᶒ":"e","ᶓ":"e","ᶖ":"i","ᶙ":"u","ᶜ":"c","ᶠ":"f","ᶻ":"z","ᶿ":"θ","Ḁ":"A","ḁ":"a","Ḃ":"B","ḃ":"b","Ḅ":"B","ḅ":"b","Ḇ":"B","ḇ":"b","Ḉ":"C","ḉ":"c","Ḋ":"D","ḋ":"d","Ḍ":"D","ḍ":"d","Ḏ":"D","ḏ":"d","Ḑ":"D","ḑ":"d","Ḓ":"D","ḓ":"d","Ḕ":"E","ḕ":"e","Ḗ":"E","ḗ":"e","Ḙ":"E","ḙ":"e","Ḛ":"E","ḛ":"e","Ḝ":"E","ḝ":"e","Ḟ":"F","ḟ":"f","Ḡ":"G","ḡ":"g","Ḣ":"H","ḣ":"h","Ḥ":"H","ḥ":"h","Ḧ":"H","ḧ":"h","Ḩ":"H","ḩ":"h","Ḫ":"H","ḫ":"h","Ḭ":"I","ḭ":"i","Ḯ":"I","ḯ":"i","Ḱ":"K","ḱ":"k","Ḳ":"K","ḳ":"k","Ḵ":"K","ḵ":"k","Ḷ":"L","ḷ":"l","Ḹ":"L","ḹ":"l","Ḻ":"L","ḻ":"l","Ḽ":"L","ḽ":"l","Ḿ":"M","ḿ":"m","Ṁ":"M","ṁ":"m","Ṃ":"M","ṃ":"m","Ṅ":"N","ṅ":"n","Ṇ":"N","ṇ":"n","Ṉ":"N","ṉ":"n","Ṋ":"N","ṋ":"n","Ṍ":"O","ṍ":"o","Ṏ":"O","ṏ":"o","Ṑ":"O","ṑ":"o","Ṓ":"O","ṓ":"o","Ṕ":"P","ṕ":"p","Ṗ":"P","ṗ":"p","Ṙ":"R","ṙ":"r","Ṛ":"R","ṛ":"r","Ṝ":"R","ṝ":"r","Ṟ":"R","ṟ":"r","Ṡ":"S","ṡ":"s","Ṣ":"S","ṣ":"s","Ṥ":"S","ṥ":"s","Ṧ":"S","ṧ":"s","Ṩ":"S","ṩ":"s","Ṫ":"T","ṫ":"t","Ṭ":"T","ṭ":"t","Ṯ":"T","ṯ":"t","Ṱ":"T","ṱ":"t","Ṳ":"U","ṳ":"u","Ṵ":"U","ṵ":"u","Ṷ":"U","ṷ":"u","Ṹ":"U","ṹ":"u","Ṻ":"U","ṻ":"u","Ṽ":"V","ṽ":"v","Ṿ":"V","ṿ":"v","Ẁ":"W","ẁ":"w","Ẃ":"W","ẃ":"w","Ẅ":"W","ẅ":"w","Ẇ":"W","ẇ":"w","Ẉ":"W","ẉ":"w","Ẋ":"X","ẋ":"x","Ẍ":"X","ẍ":"x","Ẏ":"Y","ẏ":"y","Ẑ":"Z","ẑ":"z","Ẓ":"Z","ẓ":"z","Ẕ":"Z","ẕ":"z","ẖ":"h","ẗ":"t","ẘ":"w","ẙ":"y","ẚ":"a","ẜ":"s","ẝ":"s","ẞ":"SS","Ạ":"A","ạ":"a","Ả":"A","ả":"a","Ấ":"A","ấ":"a","Ầ":"A","ầ":"a","Ẩ":"A","ẩ":"a","Ẫ":"A","ẫ":"a","Ậ":"A","ậ":"a","Ắ":"A","ắ":"a","Ằ":"A","ằ":"a","Ẳ":"A","ẳ":"a","Ẵ":"A","ẵ":"a","Ặ":"A","ặ":"a","Ẹ":"E","ẹ":"e","Ẻ":"E","ẻ":"e","Ẽ":"E","ẽ":"e","Ế":"E","ế":"e","Ề":"E","ề":"e","Ể":"E","ể":"e","Ễ":"E","ễ":"e","Ệ":"E","ệ":"e","Ỉ":"I","ỉ":"i","Ị":"I","ị":"i","Ọ":"O","ọ":"o","Ỏ":"O","ỏ":"o","Ố":"O","ố":"o","Ồ":"O","ồ":"o","Ổ":"O","ổ":"o","Ỗ":"O","ỗ":"o","Ộ":"O","ộ":"o","Ớ":"O","ớ":"o","Ờ":"O","ờ":"o","Ở":"O","ở":"o","Ỡ":"O","ỡ":"o","Ợ":"O","ợ":"o","Ụ":"U","ụ":"u","Ủ":"U","ủ":"u","Ứ":"U","ứ":"u","Ừ":"U","ừ":"u","Ử":"U","ử":"u","Ữ":"U","ữ":"u","Ự":"U","ự":"u","Ỳ":"Y","ỳ":"y","Ỵ":"Y","ỵ":"y","Ỷ":"Y","ỷ":"y","Ỹ":"Y","ỹ":"y","Ỻ":"LL","ỻ":"ll","Ỽ":"V","ỽ":"v","Ỿ":"Y","ỿ":"y","ἀ":"α","ἁ":"α","ἂ":"α","ἃ":"α","ἄ":"α","ἅ":"α","ἆ":"α","ἇ":"α","Ἀ":"Α","Ἁ":"Α","Ἂ":"Α","Ἃ":"Α","Ἄ":"Α","Ἅ":"Α","Ἆ":"Α","Ἇ":"Α","ἐ":"ε","ἑ":"ε","ἒ":"ε","ἓ":"ε","ἔ":"ε","ἕ":"ε","Ἐ":"Ε","Ἑ":"Ε","Ἒ":"Ε","Ἓ":"Ε","Ἔ":"Ε","Ἕ":"Ε","ἠ":"η","ἡ":"η","ἢ":"η","ἣ":"η","ἤ":"η","ἥ":"η","ἦ":"η","ἧ":"η","Ἠ":"Η","Ἡ":"Η","Ἢ":"Η","Ἣ":"Η","Ἤ":"Η","Ἥ":"Η","Ἦ":"Η","Ἧ":"Η","ἰ":"ι","ἱ":"ι","ἲ":"ι","ἳ":"ι","ἴ":"ι","ἵ":"ι","ἶ":"ι","ἷ":"ι","Ἰ":"Ι","Ἱ":"Ι","Ἲ":"Ι","Ἳ":"Ι","Ἴ":"Ι","Ἵ":"Ι","Ἶ":"Ι","Ἷ":"Ι","ὀ":"ο","ὁ":"ο","ὂ":"ο","ὃ":"ο","ὄ":"ο","ὅ":"ο","Ὀ":"Ο","Ὁ":"Ο","Ὂ":"Ο","Ὃ":"Ο","Ὄ":"Ο","Ὅ":"Ο","ὐ":"υ","ὑ":"υ","ὒ":"υ","ὓ":"υ","ὔ":"υ","ὕ":"υ","ὖ":"υ","ὗ":"υ","Ὑ":"Υ","Ὓ":"Υ","Ὕ":"Υ","Ὗ":"Υ","ὠ":"ω","ὡ":"ω","ὢ":"ω","ὣ":"ω","ὤ":"ω","ὥ":"ω","ὦ":"ω","ὧ":"ω","Ὠ":"Ω","Ὡ":"Ω","Ὢ":"Ω","Ὣ":"Ω","Ὤ":"Ω","Ὥ":"Ω","Ὦ":"Ω","Ὧ":"Ω","ὰ":"α","ά":"α","ὲ":"ε","έ":"ε","ὴ":"η","ή":"η","ὶ":"ι","ί":"ι","ὸ":"ο","ό":"ο","ὺ":"υ","ύ":"υ","ὼ":"ω","ώ":"ω","ᾀ":"α","ᾁ":"α","ᾂ":"α","ᾃ":"α","ᾄ":"α","ᾅ":"α","ᾆ":"α","ᾇ":"α","ᾈ":"Α","ᾉ":"Α","ᾊ":"Α","ᾋ":"Α","ᾌ":"Α","ᾍ":"Α","ᾎ":"Α","ᾏ":"Α","ᾐ":"η","ᾑ":"η","ᾒ":"η","ᾓ":"η","ᾔ":"η","ᾕ":"η","ᾖ":"η","ᾗ":"η","ᾘ":"Η","ᾙ":"Η","ᾚ":"Η","ᾛ":"Η","ᾜ":"Η","ᾝ":"Η","ᾞ":"Η","ᾟ":"Η","ᾠ":"ω","ᾡ":"ω","ᾢ":"ω","ᾣ":"ω","ᾤ":"ω","ᾥ":"ω","ᾦ":"ω","ᾧ":"ω","ᾨ":"Ω","ᾩ":"Ω","ᾪ":"Ω","ᾫ":"Ω","ᾬ":"Ω","ᾭ":"Ω","ᾮ":"Ω","ᾯ":"Ω","ᾰ":"α","ᾱ":"α","ᾲ":"α","ᾳ":"α","ᾴ":"α","ᾶ":"α","ᾷ":"α","Ᾰ":"Α","Ᾱ":"Α","Ὰ":"Α","Ά":"Α","ᾼ":"Α","ι":"ι","ῂ":"η","ῃ":"η","ῄ":"η","ῆ":"η","ῇ":"η","Ὲ":"Ε","Έ":"Ε","Ὴ":"Η","Ή":"Η","ῌ":"Η","ῐ":"ι","ῑ":"ι","ῒ":"ι","ΐ":"ι","ῖ":"ι","ῗ":"ι","Ῐ":"Ι","Ῑ":"Ι","Ὶ":"Ι","Ί":"Ι","ῠ":"υ","ῡ":"υ","ῢ":"υ","ΰ":"υ","ῤ":"ρ","ῥ":"ρ","ῦ":"υ","ῧ":"υ","Ῠ":"Υ","Ῡ":"Υ","Ὺ":"Υ","Ύ":"Υ","Ῥ":"Ρ","ῲ":"ω","ῳ":"ω","ῴ":"ω","ῶ":"ω","ῷ":"ω","Ὸ":"Ο","Ό":"Ο","Ὼ":"Ω","Ώ":"Ω","ῼ":"Ω","‐":"-","‑":"-","‒":"-","–":"-","—":"-","―":"-","‖":"||","‘":"'","’":"'","‚":",","‛":"'","“":"\"","”":"\"","„":",,","‟":"\"","․":".","‥":"..","…":"...","′":"'","″":"\"","‹":"<","›":">","‼":"!!","⁄":"/","⁅":"[","⁆":"]","⁇":"??","⁈":"?!","⁉":"!?","⁎":"*","ⁱ":"i","ⁿ":"n","ₐ":"a","ₑ":"e","ₒ":"o","ₓ":"x","ₕ":"h","ₖ":"k","ₗ":"l","ₘ":"m","ₙ":"n","ₚ":"p","ₛ":"s","ₜ":"t","₠":"CE","₢":"Cr","₣":"Fr.","₤":"L.","₧":"Pts","₹":"Rs","₺":"TL","⃝":"","⃞":"","⃟":"","⃠":"","⃢":"","⃣":"","⃤":"","℀":"a/c","℁":"a/s","ℂ":"C","℃":"°C","℅":"c/o","℆":"c/u","℉":"°F","ℊ":"g","ℋ":"H","ℌ":"H","ℍ":"H","ℎ":"h","ℐ":"I","ℑ":"I","ℒ":"L","ℓ":"l","ℕ":"N","№":"No","℗":"(P)","℘":"P","ℙ":"P","ℚ":"Q","ℛ":"R","ℜ":"R","ℝ":"R","℞":"Rx","℡":"TEL","ℤ":"Z","Ω":"Ω","ℨ":"Z","K":"K","Å":"A","ℬ":"B","ℭ":"C","ℯ":"e","ℰ":"E","ℱ":"F","ℳ":"M","ℴ":"o","ℹ":"i","℻":"FAX","ℼ":"π","ℽ":"γ","ℾ":"Γ","ℿ":"Π","ⅅ":"D","ⅆ":"d","ⅇ":"e","ⅈ":"i","ⅉ":"j","⅐":" 1/7","⅑":" 1/9","⅒":" 1/10","⅓":" 1/3","⅔":" 2/3","⅕":" 1/5","⅖":" 2/5","⅗":" 3/5","⅘":" 4/5","⅙":" 1/6","⅚":" 5/6","⅛":" 1/8","⅜":" 3/8","⅝":" 5/8","⅞":" 7/8","⅟":" 1/","Ⅰ":"I","Ⅱ":"II","Ⅲ":"III","Ⅳ":"IV","Ⅴ":"V","Ⅵ":"VI","Ⅶ":"VII","Ⅷ":"VIII","Ⅸ":"IX","Ⅹ":"X","Ⅺ":"XI","Ⅻ":"XII","Ⅼ":"L","Ⅽ":"C","Ⅾ":"D","Ⅿ":"M","ⅰ":"i","ⅱ":"ii","ⅲ":"iii","ⅳ":"iv","ⅴ":"v","ⅵ":"vi","ⅶ":"vii","ⅷ":"viii","ⅸ":"ix","ⅹ":"x","ⅺ":"xi","ⅻ":"xii","ⅼ":"l","ⅽ":"c","ⅾ":"d","ⅿ":"m","↉":" 0/3","−":"-","∕":"/","∖":"\\","∣":"|","∥":"||","≪":"<<","≫":">>","⑴":"(1)","⑵":"(2)","⑶":"(3)","⑷":"(4)","⑸":"(5)","⑹":"(6)","⑺":"(7)","⑻":"(8)","⑼":"(9)","⑽":"(10)","⑾":"(11)","⑿":"(12)","⒀":"(13)","⒁":"(14)","⒂":"(15)","⒃":"(16)","⒄":"(17)","⒅":"(18)","⒆":"(19)","⒇":"(20)","⒈":"1.","⒉":"2.","⒊":"3.","⒋":"4.","⒌":"5.","⒍":"6.","⒎":"7.","⒏":"8.","⒐":"9.","⒑":"10.","⒒":"11.","⒓":"12.","⒔":"13.","⒕":"14.","⒖":"15.","⒗":"16.","⒘":"17.","⒙":"18.","⒚":"19.","⒛":"20.","⒜":"(a)","⒝":"(b)","⒞":"(c)","⒟":"(d)","⒠":"(e)","⒡":"(f)","⒢":"(g)","⒣":"(h)","⒤":"(i)","⒥":"(j)","⒦":"(k)","⒧":"(l)","⒨":"(m)","⒩":"(n)","⒪":"(o)","⒫":"(p)","⒬":"(q)","⒭":"(r)","⒮":"(s)","⒯":"(t)","⒰":"(u)","⒱":"(v)","⒲":"(w)","⒳":"(x)","⒴":"(y)","⒵":"(z)","⦅":"((","⦆":"))","⩴":"::=","⩵":"==","⩶":"===","Ⱡ":"L","ⱡ":"l","Ɫ":"L","Ᵽ":"P","Ɽ":"R","ⱥ":"a","ⱦ":"t","Ⱨ":"H","ⱨ":"h","Ⱪ":"K","ⱪ":"k","Ⱬ":"Z","ⱬ":"z","Ɱ":"M","ⱱ":"v","Ⱳ":"W","ⱳ":"w","ⱴ":"v","ⱸ":"e","ⱺ":"o","ⱼ":"j","ⱽ":"V","Ȿ":"S","Ɀ":"Z","、":",","。":".","〇":"0","〈":"<","〉":">","《":"<<","》":">>","〔":"[","〕":"]","〘":"[","〙":"]","〚":"[","〛":"]","〝":"\"","〞":"\"","㍱":"hPa","㍲":"da","㍳":"AU","㍴":"bar","㍵":"oV","㍶":"pc","㍷":"dm","㍺":"IU","㎀":"pA","㎁":"nA","㎃":"mA","㎄":"kA","㎅":"KB","㎆":"MB","㎇":"GB","㎈":"cal","㎉":"kcal","㎊":"pF","㎋":"nF","㎎":"mg","㎏":"kg","㎐":"Hz","㎑":"kHz","㎒":"MHz","㎓":"GHz","㎔":"THz","㎙":"fm","㎚":"nm","㎜":"mm","㎝":"cm","㎞":"km","㎧":"m/s","㎩":"Pa","㎪":"kPa","㎫":"MPa","㎬":"GPa","㎭":"rad","㎮":"rad/s","㎰":"ps","㎱":"ns","㎳":"ms","㎴":"pV","㎵":"nV","㎷":"mV","㎸":"kV","㎹":"MV","㎺":"pW","㎻":"nW","㎽":"mW","㎾":"kW","㎿":"MW","㏂":"a.m.","㏃":"Bq","㏄":"cc","㏅":"cd","㏆":"C/kg","㏇":"Co.","㏈":"dB","㏉":"Gy","㏊":"ha","㏋":"HP","㏌":"in","㏍":"KK","㏎":"KM","㏏":"kt","㏐":"lm","㏑":"ln","㏒":"log","㏓":"lx","㏔":"mb","㏕":"mil","㏖":"mol","㏗":"pH","㏘":"p.m.","㏙":"PPM","㏚":"PR","㏛":"sr","㏜":"Sv","㏝":"Wb","㏞":"V/m","㏟":"A/m","ꜰ":"F","ꜱ":"S","Ꜳ":"AA","ꜳ":"aa","Ꜵ":"AO","ꜵ":"ao","Ꜷ":"AU","ꜷ":"au","Ꜹ":"AV","ꜹ":"av","Ꜻ":"AV","ꜻ":"av","Ꜽ":"AY","ꜽ":"ay","Ꝁ":"K","ꝁ":"k","Ꝃ":"K","ꝃ":"k","Ꝅ":"K","ꝅ":"k","Ꝇ":"L","ꝇ":"l","Ꝉ":"L","ꝉ":"l","Ꝋ":"O","ꝋ":"o","Ꝍ":"O","ꝍ":"o","Ꝏ":"OO","ꝏ":"oo","Ꝑ":"P","ꝑ":"p","Ꝓ":"P","ꝓ":"p","Ꝕ":"P","ꝕ":"p","Ꝗ":"Q","ꝗ":"q","Ꝙ":"Q","ꝙ":"q","Ꝟ":"V","ꝟ":"v","Ꝡ":"VY","ꝡ":"vy","Ꝥ":"TH","ꝥ":"th","Ꝧ":"TH","ꝧ":"th","ꝱ":"d","ꝲ":"l","ꝳ":"m","ꝴ":"n","ꝵ":"r","ꝶ":"R","ꝷ":"t","Ꝺ":"D","ꝺ":"d","Ꝼ":"F","ꝼ":"f","Ꞇ":"T","ꞇ":"t","Ꞑ":"N","ꞑ":"n","Ꞓ":"C","ꞓ":"c","Ꞡ":"G","ꞡ":"g","Ꞣ":"K","ꞣ":"k","Ꞥ":"N","ꞥ":"n","Ꞧ":"R","ꞧ":"r","Ꞩ":"S","ꞩ":"s","Ɦ":"H","ꟲ":"C","ꟳ":"F","ꟴ":"Q","ﬀ":"ff","ﬁ":"fi","ﬂ":"fl","ﬃ":"ffi","ﬄ":"ffl","ﬅ":"st","ﬆ":"st","︐":",","︑":",","︒":".","︓":":","︔":";","︕":"!","︖":"?","︙":"...","︰":"..","︱":"-","︲":"-","︵":"(","︶":")","︷":"{","︸":"}","︹":"[","︺":"]","︽":"<<","︾":">>","︿":"<","﹀":">","﹇":"[","﹈":"]","﹐":",","﹑":",","﹒":".","﹔":";","﹕":":","﹖":"?","﹗":"!","﹘":"-","﹙":"(","﹚":")","﹛":"{","﹜":"}","﹝":"[","﹞":"]","﹟":"#","﹠":"&","﹡":"*","﹢":"+","﹣":"-","﹤":"<","﹥":">","﹦":"=","﹨":"\\","﹩":"$","﹪":"%","﹫":"@","！":"!","＂":"\"","＃":"#","＄":"$","％":"%","＆":"&","＇":"'","（":"(","）":")","＊":"*","＋":"+","，":",","－":"-","．":".","／":"/","０":"0","１":"1","２":"2","３":"3","４":"4","５":"5","６":"6","７":"7","８":"8","９":"9","：":":","；":";","＜":"<","＝":"=","＞":">","？":"?","＠":"@","Ａ":"A","Ｂ":"B","Ｃ":"C","Ｄ":"D","Ｅ":"E","Ｆ":"F","Ｇ":"G","Ｈ":"H","Ｉ":"I","Ｊ":"J","Ｋ":"K","Ｌ":"L","Ｍ":"M","Ｎ":"N","Ｏ":"O","Ｐ":"P","Ｑ":"Q","Ｒ":"R","Ｓ":"S","Ｔ":"T","Ｕ":"U","Ｖ":"V","Ｗ":"W","Ｘ":"X","Ｙ":"Y","Ｚ":"Z","［":"[","＼":"\\","］":"]","＾":"^","＿":"_","｀":"`","ａ":"a","ｂ":"b","ｃ":"c","ｄ":"d","ｅ":"e","ｆ":"f","ｇ":"g","ｈ":"h","ｉ":"i","ｊ":"j","ｋ":"k","ｌ":"l","ｍ":"m","ｎ":"n","ｏ":"o","ｐ":"p","ｑ":"q","ｒ":"r","ｓ":"s","ｔ":"t","ｕ":"u","ｖ":"v","ｗ":"w","ｘ":"x","ｙ":"y","ｚ":"z","｛":"{","｜":"|","｝":"}","～":"~","｟":"((","｠":"))","｡":".","､":",","￩":"<-","￫":"->","𐞥":"q","𝐀":"A","𝐁":"B","𝐂":"C","𝐃":"D","𝐄":"E","𝐅":"F","𝐆":"G","𝐇":"H","𝐈":"I","𝐉":"J","𝐊":"K","𝐋":"L","𝐌":"M","𝐍":"N","𝐎":"O","𝐏":"P","𝐐":"Q","𝐑":"R","𝐒":"S","𝐓":"T","𝐔":"U","𝐕":"V","𝐖":"W","𝐗":"X","𝐘":"Y","𝐙":"Z","𝐚":"a","𝐛":"b","𝐜":"c","𝐝":"d","𝐞":"e","𝐟":"f","𝐠":"g","𝐡":"h","𝐢":"i","𝐣":"j","𝐤":"k","𝐥":"l","𝐦":"m","𝐧":"n","𝐨":"o","𝐩":"p","𝐪":"q","𝐫":"r","𝐬":"s","𝐭":"t","𝐮":"u","𝐯":"v","𝐰":"w","𝐱":"x","𝐲":"y","𝐳":"z","𝐴":"A","𝐵":"B","𝐶":"C","𝐷":"D","𝐸":"E","𝐹":"F","𝐺":"G","𝐻":"H","𝐼":"I","𝐽":"J","𝐾":"K","𝐿":"L","𝑀":"M","𝑁":"N","𝑂":"O","𝑃":"P","𝑄":"Q","𝑅":"R","𝑆":"S","𝑇":"T","𝑈":"U","𝑉":"V","𝑊":"W","𝑋":"X","𝑌":"Y","𝑍":"Z","𝑎":"a","𝑏":"b","𝑐":"c","𝑑":"d","𝑒":"e","𝑓":"f","𝑔":"g","𝑖":"i","𝑗":"j","𝑘":"k","𝑙":"l","𝑚":"m","𝑛":"n","𝑜":"o","𝑝":"p","𝑞":"q","𝑟":"r","𝑠":"s","𝑡":"t","𝑢":"u","𝑣":"v","𝑤":"w","𝑥":"x","𝑦":"y","𝑧":"z","𝑨":"A","𝑩":"B","𝑪":"C","𝑫":"D","𝑬":"E","𝑭":"F","𝑮":"G","𝑯":"H","𝑰":"I","𝑱":"J","𝑲":"K","𝑳":"L","𝑴":"M","𝑵":"N","𝑶":"O","𝑷":"P","𝑸":"Q","𝑹":"R","𝑺":"S","𝑻":"T","𝑼":"U","𝑽":"V","𝑾":"W","𝑿":"X","𝒀":"Y","𝒁":"Z","𝒂":"a","𝒃":"b","𝒄":"c","𝒅":"d","𝒆":"e","𝒇":"f","𝒈":"g","𝒉":"h","𝒊":"i","𝒋":"j","𝒌":"k","𝒍":"l","𝒎":"m","𝒏":"n","𝒐":"o","𝒑":"p","𝒒":"q","𝒓":"r","𝒔":"s","𝒕":"t","𝒖":"u","𝒗":"v","𝒘":"w","𝒙":"x","𝒚":"y","𝒛":"z","𝒜":"A","𝒞":"C","𝒟":"D","𝒢":"G","𝒥":"J","𝒦":"K","𝒩":"N","𝒪":"O","𝒫":"P","𝒬":"Q","𝒮":"S","𝒯":"T","𝒰":"U","𝒱":"V","𝒲":"W","𝒳":"X","𝒴":"Y","𝒵":"Z","𝒶":"a","𝒷":"b","𝒸":"c","𝒹":"d","𝒻":"f","𝒽":"h","𝒾":"i","𝒿":"j","𝓀":"k","𝓁":"l","𝓂":"m","𝓃":"n","𝓅":"p","𝓆":"q","𝓇":"r","𝓈":"s","𝓉":"t","𝓊":"u","𝓋":"v","𝓌":"w","𝓍":"x","𝓎":"y","𝓏":"z","𝓐":"A","𝓑":"B","𝓒":"C","𝓓":"D","𝓔":"E","𝓕":"F","𝓖":"G","𝓗":"H","𝓘":"I","𝓙":"J","𝓚":"K","𝓛":"L","𝓜":"M","𝓝":"N","𝓞":"O","𝓟":"P","𝓠":"Q","𝓡":"R","𝓢":"S","𝓣":"T","𝓤":"U","𝓥":"V","𝓦":"W","𝓧":"X","𝓨":"Y","𝓩":"Z","𝓪":"a","𝓫":"b","𝓬":"c","𝓭":"d","𝓮":"e","𝓯":"f","𝓰":"g","𝓱":"h","𝓲":"i","𝓳":"j","𝓴":"k","𝓵":"l","𝓶":"m","𝓷":"n","𝓸":"o","𝓹":"p","𝓺":"q","𝓻":"r","𝓼":"s","𝓽":"t","𝓾":"u","𝓿":"v","𝔀":"w","𝔁":"x","𝔂":"y","𝔃":"z","𝔄":"A","𝔅":"B","𝔇":"D","𝔈":"E","𝔉":"F","𝔊":"G","𝔍":"J","𝔎":"K","𝔏":"L","𝔐":"M","𝔑":"N","𝔒":"O","𝔓":"P","𝔔":"Q","𝔖":"S","𝔗":"T","𝔘":"U","𝔙":"V","𝔚":"W","𝔛":"X","𝔜":"Y","𝔞":"a","𝔟":"b","𝔠":"c","𝔡":"d","𝔢":"e","𝔣":"f","𝔤":"g","𝔥":"h","𝔦":"i","𝔧":"j","𝔨":"k","𝔩":"l","𝔪":"m","𝔫":"n","𝔬":"o","𝔭":"p","𝔮":"q","𝔯":"r","𝔰":"s","𝔱":"t","𝔲":"u","𝔳":"v","𝔴":"w","𝔵":"x","𝔶":"y","𝔷":"z","𝔸":"A","𝔹":"B","𝔻":"D","𝔼":"E","𝔽":"F","𝔾":"G","𝕀":"I","𝕁":"J","𝕂":"K","𝕃":"L","𝕄":"M","𝕆":"O","𝕊":"S","𝕋":"T","𝕌":"U","𝕍":"V","𝕎":"W","𝕏":"X","𝕐":"Y","𝕒":"a","𝕓":"b","𝕔":"c","𝕕":"d","𝕖":"e","𝕗":"f","𝕘":"g","𝕙":"h","𝕚":"i","𝕛":"j","𝕜":"k","𝕝":"l","𝕞":"m","𝕟":"n","𝕠":"o","𝕡":"p","𝕢":"q","𝕣":"r","𝕤":"s","𝕥":"t","𝕦":"u","𝕧":"v","𝕨":"w","𝕩":"x","𝕪":"y","𝕫":"z","𝕬":"A","𝕭":"B","𝕮":"C","𝕯":"D","𝕰":"E","𝕱":"F","𝕲":"G","𝕳":"H","𝕴":"I","𝕵":"J","𝕶":"K","𝕷":"L","𝕸":"M","𝕹":"N","𝕺":"O","𝕻":"P","𝕼":"Q","𝕽":"R","𝕾":"S","𝕿":"T","𝖀":"U","𝖁":"V","𝖂":"W","𝖃":"X","𝖄":"Y","𝖅":"Z","𝖆":"a","𝖇":"b","𝖈":"c","𝖉":"d","𝖊":"e","𝖋":"f","𝖌":"g","𝖍":"h","𝖎":"i","𝖏":"j","𝖐":"k","𝖑":"l","𝖒":"m","𝖓":"n","𝖔":"o","𝖕":"p","𝖖":"q","𝖗":"r","𝖘":"s","𝖙":"t","𝖚":"u","𝖛":"v","𝖜":"w","𝖝":"x","𝖞":"y","𝖟":"z","𝖠":"A","𝖡":"B","𝖢":"C","𝖣":"D","𝖤":"E","𝖥":"F","𝖦":"G","𝖧":"H","𝖨":"I","𝖩":"J","𝖪":"K","𝖫":"L","𝖬":"M","𝖭":"N","𝖮":"O","𝖯":"P","𝖰":"Q","𝖱":"R","𝖲":"S","𝖳":"T","𝖴":"U","𝖵":"V","𝖶":"W","𝖷":"X","𝖸":"Y","𝖹":"Z","𝖺":"a","𝖻":"b","𝖼":"c","𝖽":"d","𝖾":"e","𝖿":"f","𝗀":"g","𝗁":"h","𝗂":"i","𝗃":"j","𝗄":"k","𝗅":"l","𝗆":"m","𝗇":"n","𝗈":"o","𝗉":"p","𝗊":"q","𝗋":"r","𝗌":"s","𝗍":"t","𝗎":"u","𝗏":"v","𝗐":"w","𝗑":"x","𝗒":"y","𝗓":"z","𝗔":"A","𝗕":"B","𝗖":"C","𝗗":"D","𝗘":"E","𝗙":"F","𝗚":"G","𝗛":"H","𝗜":"I","𝗝":"J","𝗞":"K","𝗟":"L","𝗠":"M","𝗡":"N","𝗢":"O","𝗣":"P","𝗤":"Q","𝗥":"R","𝗦":"S","𝗧":"T","𝗨":"U","𝗩":"V","𝗪":"W","𝗫":"X","𝗬":"Y","𝗭":"Z","𝗮":"a","𝗯":"b","𝗰":"c","𝗱":"d","𝗲":"e","𝗳":"f","𝗴":"g","𝗵":"h","𝗶":"i","𝗷":"j","𝗸":"k","𝗹":"l","𝗺":"m","𝗻":"n","𝗼":"o","𝗽":"p","𝗾":"q","𝗿":"r","𝘀":"s","𝘁":"t","𝘂":"u","𝘃":"v","𝘄":"w","𝘅":"x","𝘆":"y","𝘇":"z","𝘈":"A","𝘉":"B","𝘊":"C","𝘋":"D","𝘌":"E","𝘍":"F","𝘎":"G","𝘏":"H","𝘐":"I","𝘑":"J","𝘒":"K","𝘓":"L","𝘔":"M","𝘕":"N","𝘖":"O","𝘗":"P","𝘘":"Q","𝘙":"R","𝘚":"S","𝘛":"T","𝘜":"U","𝘝":"V","𝘞":"W","𝘟":"X","𝘠":"Y","𝘡":"Z","𝘢":"a","𝘣":"b","𝘤":"c","𝘥":"d","𝘦":"e","𝘧":"f","𝘨":"g","𝘩":"h","𝘪":"i","𝘫":"j","𝘬":"k","𝘭":"l","𝘮":"m","𝘯":"n","𝘰":"o","𝘱":"p","𝘲":"q","𝘳":"r","𝘴":"s","𝘵":"t","𝘶":"u","𝘷":"v","𝘸":"w","𝘹":"x","𝘺":"y","𝘻":"z","𝘼":"A","𝘽":"B","𝘾":"C","𝘿":"D","𝙀":"E","𝙁":"F","𝙂":"G","𝙃":"H","𝙄":"I","𝙅":"J","𝙆":"K","𝙇":"L","𝙈":"M","𝙉":"N","𝙊":"O","𝙋":"P","𝙌":"Q","𝙍":"R","𝙎":"S","𝙏":"T","𝙐":"U","𝙑":"V","𝙒":"W","𝙓":"X","𝙔":"Y","𝙕":"Z","𝙖":"a","𝙗":"b","𝙘":"c","𝙙":"d","𝙚":"e","𝙛":"f","𝙜":"g","𝙝":"h","𝙞":"i","𝙟":"j","𝙠":"k","𝙡":"l","𝙢":"m","𝙣":"n","𝙤":"o","𝙥":"p","𝙦":"q","𝙧":"r","𝙨":"s","𝙩":"t","𝙪":"u","𝙫":"v","𝙬":"w","𝙭":"x","𝙮":"y","𝙯":"z","𝙰":"A","𝙱":"B","𝙲":"C","𝙳":"D","𝙴":"E","𝙵":"F","𝙶":"G","𝙷":"H","𝙸":"I","𝙹":"J","𝙺":"K","𝙻":"L","𝙼":"M","𝙽":"N","𝙾":"O","𝙿":"P","𝚀":"Q","𝚁":"R","𝚂":"S","𝚃":"T","𝚄":"U","𝚅":"V","𝚆":"W","𝚇":"X","𝚈":"Y","𝚉":"Z","𝚊":"a","𝚋":"b","𝚌":"c","𝚍":"d","𝚎":"e","𝚏":"f","𝚐":"g","𝚑":"h","𝚒":"i","𝚓":"j","𝚔":"k","𝚕":"l","𝚖":"m","𝚗":"n","𝚘":"o","𝚙":"p","𝚚":"q","𝚛":"r","𝚜":"s","𝚝":"t","𝚞":"u","𝚟":"v","𝚠":"w","𝚡":"x","𝚢":"y","𝚣":"z","𝚨":"Α","𝚩":"Β","𝚪":"Γ","𝚫":"Δ","𝚬":"Ε","𝚭":"Ζ","𝚮":"Η","𝚯":"Θ","𝚰":"Ι","𝚱":"Κ","𝚲":"Λ","𝚳":"Μ","𝚴":"Ν","𝚵":"Ξ","𝚶":"Ο","𝚷":"Π","𝚸":"Ρ","𝚺":"Σ","𝚻":"Τ","𝚼":"Υ","𝚽":"Φ","𝚾":"Χ","𝚿":"Ψ","𝛀":"Ω","𝛂":"α","𝛃":"β","𝛄":"γ","𝛅":"δ","𝛆":"ε","𝛇":"ζ","𝛈":"η","𝛉":"θ","𝛊":"ι","𝛋":"κ","𝛌":"λ","𝛍":"μ","𝛎":"ν","𝛏":"ξ","𝛐":"ο","𝛑":"π","𝛒":"ρ","𝛓":"ς","𝛔":"σ","𝛕":"τ","𝛖":"υ","𝛗":"φ","𝛘":"χ","𝛙":"ψ","𝛚":"ω","𝛢":"Α","𝛣":"Β","𝛤":"Γ","𝛥":"Δ","𝛦":"Ε","𝛧":"Ζ","𝛨":"Η","𝛩":"Θ","𝛪":"Ι","𝛫":"Κ","𝛬":"Λ","𝛭":"Μ","𝛮":"Ν","𝛯":"Ξ","𝛰":"Ο","𝛱":"Π","𝛲":"Ρ","𝛴":"Σ","𝛵":"Τ","𝛶":"Υ","𝛷":"Φ","𝛸":"Χ","𝛹":"Ψ","𝛺":"Ω","𝛼":"α","𝛽":"β","𝛾":"γ","𝛿":"δ","𝜀":"ε","𝜁":"ζ","𝜂":"η","𝜃":"θ","𝜄":"ι","𝜅":"κ","𝜆":"λ","𝜇":"μ","𝜈":"ν","𝜉":"ξ","𝜊":"ο","𝜋":"π","𝜌":"ρ","𝜍":"ς","𝜎":"σ","𝜏":"τ","𝜐":"υ","𝜑":"φ","𝜒":"χ","𝜓":"ψ","𝜔":"ω","𝜜":"Α","𝜝":"Β","𝜞":"Γ","𝜟":"Δ","𝜠":"Ε","𝜡":"Ζ","𝜢":"Η","𝜣":"Θ","𝜤":"Ι","𝜥":"Κ","𝜦":"Λ","𝜧":"Μ","𝜨":"Ν","𝜩":"Ξ","𝜪":"Ο","𝜫":"Π","𝜬":"Ρ","𝜮":"Σ","𝜯":"Τ","𝜰":"Υ","𝜱":"Φ","𝜲":"Χ","𝜳":"Ψ","𝜴":"Ω","𝜶":"α","𝜷":"β","𝜸":"γ","𝜹":"δ","𝜺":"ε","𝜻":"ζ","𝜼":"η","𝜽":"θ","𝜾":"ι","𝜿":"κ","𝝀":"λ","𝝁":"μ","𝝂":"ν","𝝃":"ξ","𝝄":"ο","𝝅":"π","𝝆":"ρ","𝝇":"ς","𝝈":"σ","𝝉":"τ","𝝊":"υ","𝝋":"φ","𝝌":"χ","𝝍":"ψ","𝝎":"ω","𝝖":"Α","𝝗":"Β","𝝘":"Γ","𝝙":"Δ","𝝚":"Ε","𝝛":"Ζ","𝝜":"Η","𝝝":"Θ","𝝞":"Ι","𝝟":"Κ","𝝠":"Λ","𝝡":"Μ","𝝢":"Ν","𝝣":"Ξ","𝝤":"Ο","𝝥":"Π","𝝦":"Ρ","𝝨":"Σ","𝝩":"Τ","𝝪":"Υ","𝝫":"Φ","𝝬":"Χ","𝝭":"Ψ","𝝮":"Ω","𝝰":"α","𝝱":"β","𝝲":"γ","𝝳":"δ","𝝴":"ε","𝝵":"ζ","𝝶":"η","𝝷":"θ","𝝸":"ι","𝝹":"κ","𝝺":"λ","𝝻":"μ","𝝼":"ν","𝝽":"ξ","𝝾":"ο","𝝿":"π","𝞀":"ρ","𝞁":"ς","𝞂":"σ","𝞃":"τ","𝞄":"υ","𝞅":"φ","𝞆":"χ","𝞇":"ψ","𝞈":"ω","𝞐":"Α","𝞑":"Β","𝞒":"Γ","𝞓":"Δ","𝞔":"Ε","𝞕":"Ζ","𝞖":"Η","𝞗":"Θ","𝞘":"Ι","𝞙":"Κ","𝞚":"Λ","𝞛":"Μ","𝞜":"Ν","𝞝":"Ξ","𝞞":"Ο","𝞟":"Π","𝞠":"Ρ","𝞢":"Σ","𝞣":"Τ","𝞤":"Υ","𝞥":"Φ","𝞦":"Χ","𝞧":"Ψ","𝞨":"Ω","𝞪":"α","𝞫":"β","𝞬":"γ","𝞭":"δ","𝞮":"ε","𝞯":"ζ","𝞰":"η","𝞱":"θ","𝞲":"ι","𝞳":"κ","𝞴":"λ","𝞵":"μ","𝞶":"ν","𝞷":"ξ","𝞸":"ο","𝞹":"π","𝞺":"ρ","𝞻":"ς","𝞼":"σ","𝞽":"τ","𝞾":"υ","𝞿":"φ","𝟀":"χ","𝟁":"ψ","𝟂":"ω","🄀":"0.","🄁":"0,","🄂":"1,","🄃":"2,","🄄":"3,","🄅":"4,","🄆":"5,","🄇":"6,","🄈":"7,","🄉":"8,","🄊":"9,","🄐":"(A)","🄑":"(B)","🄒":"(C)","🄓":"(D)","🄔":"(E)","🄕":"(F)","🄖":"(G)","🄗":"(H)","🄘":"(I)","🄙":"(J)","🄚":"(K)","🄛":"(L)","🄜":"(M)","🄝":"(N)","🄞":"(O)","🄟":"(P)","🄠":"(Q)","🄡":"(R)","🄢":"(S)","🄣":"(T)","🄤":"(U)","🄥":"(V)","🄦":"(W)","🄧":"(X)","🄨":"(Y)","🄩":"(Z)"}$rules$::jsonb ->> source_character, source_character),
      '' ORDER BY ordinal
    ),
    ''
  )
  FROM pg_catalog.regexp_split_to_table(
    pg_catalog.lower(
      COALESCE(input, '') COLLATE pg_catalog.pg_unicode_fast
    ),
    ''
  ) WITH ORDINALITY AS characters(source_character, ordinal)
);

COMMENT ON FUNCTION lcm.normalize_search_text(text) IS
  'PostgreSQL 18 pg_unicode_fast case mapping; pinned PostgreSQL 18.4 unaccent.rules SHA-256 ecf4c41c0883dee17d02431e0a7f24a2611aadf8fe1da06e98c6ccb4acc4a981; canonical JSON SHA-256 21d9c6e1f20f37d7d804b81dc7f62372b68de9ff05037d5f4f3c85cef4868588 (2661 rules)';

CREATE TABLE lcm.machines (
  machine_id uuid PRIMARY KEY DEFAULT uuidv7(),
  identity_key text NOT NULL UNIQUE CHECK (btrim(identity_key) <> ''),
  display_name text CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((uuid_extract_version(machine_id) = 7) IS TRUE),
  CHECK (last_seen_at >= registered_at)
);

CREATE TABLE lcm.projects (
  project_id uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((uuid_extract_version(project_id) = 7) IS TRUE),
  CHECK (updated_at >= created_at)
);

CREATE TABLE lcm.project_aliases (
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  machine_id uuid NOT NULL REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  path text NOT NULL CHECK (path <> ''),
  normalized_path text NOT NULL CHECK (normalized_path <> '' AND normalized_path = btrim(normalized_path)),
  linked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (machine_id, normalized_path)
);

CREATE INDEX project_aliases_project_idx
  ON lcm.project_aliases (project_id, machine_id, normalized_path);

CREATE TABLE lcm.conversations (
  conversation_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  session_id text NOT NULL CHECK (btrim(session_id) <> ''),
  title text,
  bootstrapped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (project_id, conversation_id),
  CHECK (updated_at >= created_at),
  CHECK (bootstrapped_at IS NULL OR bootstrapped_at >= created_at)
);

CREATE INDEX conversations_project_order_idx
  ON lcm.conversations (project_id, created_at DESC, conversation_id DESC);
CREATE INDEX conversations_session_lookup_idx
  ON lcm.conversations (
    project_id, session_id, created_at DESC, conversation_id DESC
  );

CREATE TABLE lcm.messages (
  message_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content text NOT NULL,
  token_count bigint NOT NULL CHECK (token_count >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content))
  ) STORED,
  UNIQUE (project_id, conversation_id, seq),
  UNIQUE (project_id, conversation_id, message_id),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES lcm.conversations(project_id, conversation_id) ON DELETE CASCADE
);

CREATE INDEX messages_project_created_idx
  ON lcm.messages (project_id, created_at DESC, message_id DESC);
CREATE INDEX messages_search_document_idx
  ON lcm.messages USING gin (search_document);
CREATE INDEX messages_content_trgm_idx
  ON lcm.messages USING gin (lcm.normalize_search_text(content) public.gin_trgm_ops);

CREATE TABLE lcm.message_parts (
  part_id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  message_id bigint NOT NULL,
  session_id text NOT NULL CHECK (btrim(session_id) <> ''),
  part_type text NOT NULL CHECK (part_type IN (
    'text', 'reasoning', 'tool', 'patch', 'file', 'subtask', 'compaction',
    'step_start', 'step_finish', 'snapshot', 'agent', 'retry'
  )),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text_content text,
  is_ignored boolean,
  is_synthetic boolean,
  tool_call_id text,
  tool_name text,
  tool_status text,
  tool_input text,
  tool_output text,
  tool_error text,
  tool_title text,
  patch_hash text,
  patch_files text,
  file_mime text,
  file_name text,
  file_url text,
  subtask_prompt text,
  subtask_desc text,
  subtask_agent text,
  step_reason text,
  step_cost double precision CHECK (
    step_cost IS NULL OR (
      step_cost >= 0 AND step_cost < 'Infinity'::double precision
    )
  ),
  step_tokens_in bigint CHECK (step_tokens_in IS NULL OR step_tokens_in >= 0),
  step_tokens_out bigint CHECK (step_tokens_out IS NULL OR step_tokens_out >= 0),
  snapshot_hash text,
  compaction_auto boolean,
  metadata text,
  UNIQUE (project_id, conversation_id, message_id, ordinal),
  FOREIGN KEY (project_id, conversation_id, message_id)
    REFERENCES lcm.messages(project_id, conversation_id, message_id) ON DELETE CASCADE
);

CREATE INDEX message_parts_type_idx
  ON lcm.message_parts (project_id, part_type, message_id, ordinal);

CREATE TABLE lcm.native_transcripts (
  transcript_id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  machine_id uuid NOT NULL REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  client_name text NOT NULL CHECK (btrim(client_name) <> ''),
  format_name text NOT NULL CHECK (btrim(format_name) <> ''),
  format_version text NOT NULL CHECK (btrim(format_version) <> ''),
  native_session_id text NOT NULL CHECK (btrim(native_session_id) <> ''),
  source_locator text NOT NULL CHECK (source_locator <> ''),
  source_ordinal bigint NOT NULL CHECK (source_ordinal >= 0),
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  scrubber_version text NOT NULL CHECK (btrim(scrubber_version) <> ''),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  ingest_key text NOT NULL CHECK (ingest_key ~ '^[0-9a-f]{64}$'),
  native_payload jsonb NOT NULL CHECK (jsonb_typeof(native_payload) IN ('object', 'array')),
  UNIQUE (project_id, machine_id, ingest_key),
  UNIQUE (project_id, transcript_id),
  CHECK ((uuid_extract_version(transcript_id) = 7) IS TRUE),
  CHECK (ingested_at >= observed_at)
);

CREATE INDEX native_transcripts_source_order_idx
  ON lcm.native_transcripts (
    project_id, machine_id, client_name, source_locator, source_ordinal, transcript_id
  );
CREATE INDEX native_transcripts_session_idx
  ON lcm.native_transcripts (project_id, native_session_id, observed_at, transcript_id);
CREATE INDEX native_transcripts_machine_idx
  ON lcm.native_transcripts (machine_id, transcript_id);
CREATE INDEX native_transcripts_payload_idx
  ON lcm.native_transcripts USING gin (native_payload jsonb_path_ops);

CREATE TABLE lcm.transcript_messages (
  project_id uuid NOT NULL,
  transcript_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  message_id bigint NOT NULL,
  source_ordinal integer NOT NULL CHECK (source_ordinal >= 0),
  PRIMARY KEY (project_id, transcript_id, message_id),
  UNIQUE (project_id, transcript_id, source_ordinal),
  FOREIGN KEY (project_id, transcript_id)
    REFERENCES lcm.native_transcripts(project_id, transcript_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id, message_id)
    REFERENCES lcm.messages(project_id, conversation_id, message_id) ON DELETE RESTRICT
);

CREATE INDEX transcript_messages_message_idx
  ON lcm.transcript_messages (project_id, conversation_id, message_id, transcript_id);

CREATE TABLE lcm.summaries (
  summary_id text NOT NULL DEFAULT uuidv7()::text,
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('leaf', 'condensed')),
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  content text NOT NULL,
  token_count bigint NOT NULL CHECK (token_count >= 0),
  earliest_at timestamptz,
  latest_at timestamptz,
  descendant_count bigint NOT NULL DEFAULT 0 CHECK (descendant_count >= 0),
  descendant_token_count bigint NOT NULL DEFAULT 0 CHECK (descendant_token_count >= 0),
  source_message_token_count bigint NOT NULL DEFAULT 0 CHECK (source_message_token_count >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content))
  ) STORED,
  PRIMARY KEY (project_id, summary_id),
  UNIQUE (project_id, conversation_id, summary_id),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES lcm.conversations(project_id, conversation_id) ON DELETE CASCADE,
  CHECK (earliest_at IS NULL OR latest_at IS NULL OR earliest_at <= latest_at)
);

CREATE INDEX summaries_conversation_order_idx
  ON lcm.summaries (project_id, conversation_id, created_at, summary_id);
CREATE INDEX summaries_project_recent_idx
  ON lcm.summaries (project_id, created_at DESC, summary_id DESC);
CREATE INDEX summaries_search_document_idx
  ON lcm.summaries USING gin (search_document);
CREATE INDEX summaries_content_trgm_idx
  ON lcm.summaries USING gin (lcm.normalize_search_text(content) public.gin_trgm_ops);

CREATE TABLE lcm.summary_messages (
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  summary_id text NOT NULL,
  message_id bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id, summary_id, message_id),
  UNIQUE (project_id, summary_id, ordinal),
  FOREIGN KEY (project_id, conversation_id, summary_id)
    REFERENCES lcm.summaries(project_id, conversation_id, summary_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id, message_id)
    REFERENCES lcm.messages(project_id, conversation_id, message_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX summary_messages_message_idx
  ON lcm.summary_messages (project_id, conversation_id, message_id, summary_id);
CREATE INDEX summary_messages_summary_idx
  ON lcm.summary_messages (project_id, conversation_id, summary_id);

CREATE TABLE lcm.summary_parents (
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  summary_id text NOT NULL,
  parent_summary_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id, summary_id, parent_summary_id),
  UNIQUE (project_id, summary_id, ordinal),
  FOREIGN KEY (project_id, conversation_id, summary_id)
    REFERENCES lcm.summaries(project_id, conversation_id, summary_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id, parent_summary_id)
    REFERENCES lcm.summaries(project_id, conversation_id, summary_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (summary_id <> parent_summary_id)
);

CREATE INDEX summary_parents_parent_idx
  ON lcm.summary_parents (project_id, conversation_id, parent_summary_id, ordinal, summary_id);
CREATE INDEX summary_parents_summary_idx
  ON lcm.summary_parents (project_id, conversation_id, summary_id);

CREATE TABLE lcm.context_items (
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  item_type text NOT NULL CHECK (item_type IN ('message', 'summary')),
  message_id bigint,
  summary_id text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, conversation_id, ordinal),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES lcm.conversations(project_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, conversation_id, message_id)
    REFERENCES lcm.messages(project_id, conversation_id, message_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, conversation_id, summary_id)
    REFERENCES lcm.summaries(project_id, conversation_id, summary_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
    (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
  )
);

CREATE INDEX context_items_message_idx
  ON lcm.context_items (project_id, conversation_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX context_items_summary_idx
  ON lcm.context_items (project_id, conversation_id, summary_id) WHERE summary_id IS NOT NULL;

CREATE TABLE lcm.large_files (
  file_id text NOT NULL DEFAULT uuidv7()::text,
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  file_name text,
  mime_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  storage_uri text NOT NULL CHECK (btrim(storage_uri) <> ''),
  exploration_summary text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, file_id),
  UNIQUE (project_id, conversation_id, file_id),
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES lcm.conversations(project_id, conversation_id) ON DELETE CASCADE
);

CREATE INDEX large_files_conversation_order_idx
  ON lcm.large_files (project_id, conversation_id, created_at, file_id);

CREATE TABLE lcm.summary_large_files (
  project_id uuid NOT NULL,
  conversation_id bigint NOT NULL,
  summary_id text NOT NULL,
  file_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id, summary_id, ordinal),
  FOREIGN KEY (project_id, conversation_id, summary_id)
    REFERENCES lcm.summaries(project_id, conversation_id, summary_id) ON DELETE CASCADE
);

COMMENT ON TABLE lcm.summary_large_files IS
  'Ordered summary provenance whose file_id is deliberately opaque: unresolved and cross-conversation references are valid, and deleting a large_files row must preserve this reference.';

CREATE INDEX summary_large_files_file_idx
  ON lcm.summary_large_files (project_id, file_id, conversation_id, summary_id, ordinal);
CREATE INDEX summary_large_files_summary_idx
  ON lcm.summary_large_files (project_id, conversation_id, summary_id);

CREATE TABLE lcm.promoted_memories (
  memory_id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  content text NOT NULL CHECK (content <> ''),
  source_summary_id text,
  source_project_id text,
  session_id text,
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  confidence double precision NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(content))
  ) STORED,
  UNIQUE (project_id, memory_id),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE INDEX promoted_memories_active_order_idx
  ON lcm.promoted_memories (project_id, created_at, memory_id) WHERE archived_at IS NULL;
CREATE INDEX promoted_memories_source_summary_idx
  ON lcm.promoted_memories (project_id, source_project_id, source_summary_id)
  WHERE source_summary_id IS NOT NULL;
CREATE INDEX promoted_memories_source_project_idx
  ON lcm.promoted_memories (project_id, source_project_id, created_at, memory_id)
  WHERE source_project_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX promoted_memories_metadata_idx
  ON lcm.promoted_memories USING gin (metadata jsonb_path_ops);
CREATE INDEX promoted_memories_search_document_idx
  ON lcm.promoted_memories USING gin (search_document);
CREATE INDEX promoted_memories_content_trgm_idx
  ON lcm.promoted_memories USING gin (lcm.normalize_search_text(content) public.gin_trgm_ops);

CREATE TABLE lcm.promoted_memory_tags (
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  tag text NOT NULL,
  normalized_tag text GENERATED ALWAYS AS (
    pg_catalog.lower(tag COLLATE pg_catalog.pg_unicode_fast)
  ) STORED,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('lcm.search_v1'::regconfig, lcm.normalize_search_text(tag))
  ) STORED,
  PRIMARY KEY (project_id, memory_id, ordinal),
  FOREIGN KEY (project_id, memory_id)
    REFERENCES lcm.promoted_memories(project_id, memory_id) ON DELETE CASCADE
);

CREATE INDEX promoted_memory_tags_lookup_idx
  ON lcm.promoted_memory_tags (project_id, tag, memory_id);
CREATE INDEX promoted_memory_tags_normalized_lookup_idx
  ON lcm.promoted_memory_tags (project_id, normalized_tag, memory_id);
CREATE INDEX promoted_memory_tags_search_document_idx
  ON lcm.promoted_memory_tags USING gin (search_document);
CREATE INDEX promoted_memory_tags_tag_trgm_idx
  ON lcm.promoted_memory_tags USING gin (lcm.normalize_search_text(tag) public.gin_trgm_ops);

CREATE TABLE lcm.recall_surfacing (
  surfacing_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  memory_id text NOT NULL,
  session_id text,
  surfaced_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX recall_surfacing_memory_order_idx
  ON lcm.recall_surfacing (project_id, memory_id, surfaced_at DESC, surfacing_id DESC);
CREATE INDEX recall_surfacing_session_order_idx
  ON lcm.recall_surfacing (project_id, session_id, surfaced_at, surfacing_id)
  WHERE session_id IS NOT NULL;

CREATE TABLE lcm.redaction_counters (
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('built_in', 'global', 'project', 'gitleaks')),
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, category)
);

CREATE TABLE lcm.ingest_checkpoints (
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  machine_id uuid NOT NULL REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  client_name text NOT NULL CHECK (btrim(client_name) <> ''),
  source_locator text NOT NULL CHECK (source_locator <> ''),
  last_source_ordinal bigint NOT NULL DEFAULT 0 CHECK (last_source_ordinal >= 0),
  imported_count bigint NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  skipped_count bigint NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  quarantined_count bigint NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, machine_id, client_name, source_locator)
);

CREATE INDEX ingest_checkpoints_payload_idx
  ON lcm.ingest_checkpoints USING gin (checkpoint jsonb_path_ops);
CREATE INDEX ingest_checkpoints_machine_idx
  ON lcm.ingest_checkpoints (machine_id, project_id, client_name, source_locator);

CREATE TABLE lcm.session_ingest_log (
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  session_id text NOT NULL CHECK (btrim(session_id) <> ''),
  message_count bigint NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (project_id, session_id)
);

CREATE INDEX session_ingest_log_completed_idx
  ON lcm.session_ingest_log (project_id, completed_at DESC, session_id);

CREATE TABLE lcm.session_instructions (
  instruction_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  machine_id uuid REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  slot integer NOT NULL DEFAULT 1 CHECK (slot >= 0),
  content text NOT NULL,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE NULLS NOT DISTINCT (project_id, machine_id, slot)
);

CREATE INDEX session_instructions_machine_idx
  ON lcm.session_instructions (machine_id, instruction_id) WHERE machine_id IS NOT NULL;

CREATE TABLE lcm.passive_event_inbox (
  inbox_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  machine_id uuid NOT NULL REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  machine_sequence bigint NOT NULL CHECK (machine_sequence >= 0),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'retry', 'applied', 'quarantined'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claimed_at timestamptz,
  claimed_by text,
  applied_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text,
  UNIQUE (machine_id, event_id),
  UNIQUE (machine_id, machine_sequence),
  CHECK (next_attempt_at >= received_at),
  CHECK (claimed_by IS NULL OR btrim(claimed_by) <> ''),
  CHECK (quarantine_reason IS NULL OR pg_catalog.btrim(quarantine_reason) <> ''),
  CHECK ((claimed_at IS NULL) = (claimed_by IS NULL)),
  CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CHECK ((status = 'quarantined') = (quarantined_at IS NOT NULL)),
  CHECK ((quarantined_at IS NULL) = (quarantine_reason IS NULL)),
  CHECK (claimed_at IS NULL OR claimed_at >= received_at),
  CHECK (applied_at IS NULL OR applied_at >= received_at),
  CHECK (quarantined_at IS NULL OR quarantined_at >= received_at)
);

CREATE INDEX passive_event_inbox_ready_idx
  ON lcm.passive_event_inbox (project_id, machine_id, machine_sequence, inbox_id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX passive_event_inbox_retry_idx
  ON lcm.passive_event_inbox (next_attempt_at, project_id, machine_id, machine_sequence)
  WHERE status = 'retry';
CREATE INDEX passive_event_inbox_claimed_idx
  ON lcm.passive_event_inbox (claimed_at, project_id, machine_id, machine_sequence)
  WHERE status = 'claimed';
CREATE INDEX passive_event_inbox_payload_idx
  ON lcm.passive_event_inbox USING gin (payload jsonb_path_ops);
CREATE INDEX passive_event_inbox_project_idx
  ON lcm.passive_event_inbox (project_id, inbox_id);

CREATE TABLE lcm.fenced_leases (
  project_id uuid NOT NULL REFERENCES lcm.projects(project_id) ON DELETE RESTRICT,
  resource_type text NOT NULL CHECK (btrim(resource_type) <> ''),
  resource_key text NOT NULL CHECK (btrim(resource_key) <> ''),
  owner_machine_id uuid NOT NULL REFERENCES lcm.machines(machine_id) ON DELETE RESTRICT,
  owner_process_id text NOT NULL CHECK (btrim(owner_process_id) <> ''),
  operation text NOT NULL CHECK (btrim(operation) <> ''),
  fencing_token bigint GENERATED ALWAYS AS IDENTITY CHECK (fencing_token > 0),
  acquired_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  renewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (project_id, resource_type, resource_key),
  CHECK (renewed_at >= acquired_at),
  CHECK (expires_at > renewed_at),
  CHECK (released_at IS NULL OR released_at >= renewed_at)
);

CREATE INDEX fenced_leases_owner_idx
  ON lcm.fenced_leases (owner_machine_id, owner_process_id, operation)
  WHERE released_at IS NULL;
CREATE INDEX fenced_leases_expiry_idx
  ON lcm.fenced_leases (expires_at, project_id, resource_type, resource_key)
  WHERE released_at IS NULL;
CREATE INDEX fenced_leases_owner_machine_idx
  ON lcm.fenced_leases (owner_machine_id, project_id, resource_type, resource_key);

REVOKE ALL PRIVILEGES ON TABLE
  lcm.schema_migrations,
  lcm.machines,
  lcm.projects,
  lcm.project_aliases,
  lcm.conversations,
  lcm.messages,
  lcm.message_parts,
  lcm.native_transcripts,
  lcm.transcript_messages,
  lcm.summaries,
  lcm.summary_messages,
  lcm.summary_parents,
  lcm.context_items,
  lcm.large_files,
  lcm.summary_large_files,
  lcm.promoted_memories,
  lcm.promoted_memory_tags,
  lcm.recall_surfacing,
  lcm.redaction_counters,
  lcm.ingest_checkpoints,
  lcm.session_ingest_log,
  lcm.session_instructions,
  lcm.passive_event_inbox,
  lcm.fenced_leases
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE
  lcm.conversations_conversation_id_seq,
  lcm.messages_message_id_seq,
  lcm.recall_surfacing_surfacing_id_seq,
  lcm.session_instructions_instruction_id_seq,
  lcm.passive_event_inbox_inbox_id_seq,
  lcm.fenced_leases_fencing_token_seq
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION lcm.normalize_search_text(text) FROM PUBLIC;
