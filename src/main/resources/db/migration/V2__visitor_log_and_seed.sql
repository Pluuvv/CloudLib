CREATE TABLE visitor_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenant(id),
  member_ref  VARCHAR(80) NOT NULL,
  check_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Data for Multi-Tenancy Testing & Demo
INSERT INTO tenant (id, code, name) VALUES
  (1, 'upnvj', 'Perpustakaan UPN Veteran Jakarta'),
  (2, 'poltek', 'Perpustakaan Kampus Mitra')
ON CONFLICT (id) DO NOTHING;

INSERT INTO book (id, tenant_id, title, author, isbn) VALUES
  (1, 1, 'Cloud Computing: Principles and Paradigms', 'Rajkumar Buyya', '978-0470887998'),
  (2, 1, 'Designing Data-Intensive Applications', 'Martin Kleppmann', '978-1449373320'),
  (3, 2, 'Kubernetes in Action', 'Marko Luksa', '978-1617293726')
ON CONFLICT (id) DO NOTHING;

INSERT INTO book_copy (id, tenant_id, book_id, barcode, status) VALUES
  (1, 1, 1, 'UPN-CC-001', 'AVAILABLE'),
  (2, 1, 1, 'UPN-CC-002', 'AVAILABLE'),
  (3, 1, 2, 'UPN-DD-001', 'AVAILABLE'),
  (4, 2, 3, 'POL-K8-001', 'AVAILABLE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO computer (id, tenant_id, label) VALUES
  (1, 1, 'PC-LAB-01'),
  (2, 1, 'PC-LAB-02'),
  (3, 2, 'PC-POL-01')
ON CONFLICT (id) DO NOTHING;

SELECT setval('tenant_id_seq', (SELECT COALESCE(MAX(id), 1) FROM tenant));
SELECT setval('book_id_seq', (SELECT COALESCE(MAX(id), 1) FROM book));
SELECT setval('book_copy_id_seq', (SELECT COALESCE(MAX(id), 1) FROM book_copy));
SELECT setval('computer_id_seq', (SELECT COALESCE(MAX(id), 1) FROM computer));
