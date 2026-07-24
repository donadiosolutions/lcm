ALTER TABLE lcm.machines
  DROP CONSTRAINT machines_display_name_check,
  ADD CONSTRAINT machines_display_name_check CHECK (
    display_name IS NULL
    OR (
      (
        pg_catalog.char_length(
          pg_catalog.btrim(
            display_name,
            U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000\FEFF'
          )
        )
        OPERATOR(pg_catalog.+)
        pg_catalog.char_length(
          pg_catalog.regexp_replace(
            pg_catalog.btrim(
              display_name,
              U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000\FEFF'
            ),
            U&'[^\+010000-\+10FFFF]',
            '',
            'g'
          )
        )
      ) BETWEEN 1 AND 256
      AND display_name OPERATOR(pg_catalog.!~)
        U&'[\0001-\001F\007F-\009F\061C\200E-\200F\2028-\202E\2066-\2069]'
    )
  );
