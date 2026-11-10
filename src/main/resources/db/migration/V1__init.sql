CREATE TABLE tenant (
  id   BIGSERIAL PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  CONSTRAINT uq_tenant_code UNIQUE (code)
);

CREATE TABLE book (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenant(id),
  title     VARCHAR(255) NOT NULL,
  author    VARCHAR(255),
  isbn      VARCHAR(20)
);

CREATE TABLE book_copy (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenant(id),
  book_id   BIGINT NOT NULL REFERENCES book(id),
  barcode   VARCHAR(40) NOT NULL,
  status    VARCHAR(11) NOT NULL DEFAULT 'AVAILABLE',
  CONSTRAINT uq_book_copy_barcode UNIQUE (tenant_id, barcode)
);

CREATE TABLE loan (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenant(id),
  book_copy_id BIGINT NOT NULL REFERENCES book_copy(id),
  member_ref   VARCHAR(80) NOT NULL,
  borrowed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at       TIMESTAMPTZ NOT NULL,
  returned_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_loan_active_copy ON loan (book_copy_id) WHERE returned_at IS NULL;

CREATE TABLE computer (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenant(id),
  label     VARCHAR(40) NOT NULL,
  CONSTRAINT uq_computer_label UNIQUE (tenant_id, label)
);

CREATE TABLE computer_reservation (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenant(id),
  computer_id BIGINT NOT NULL REFERENCES computer(id),
  member_ref  VARCHAR(80) NOT NULL,
  slot_start  TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_reservation_slot UNIQUE (computer_id, slot_start)
);
