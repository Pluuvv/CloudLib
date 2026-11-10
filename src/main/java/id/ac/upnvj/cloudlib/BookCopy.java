package id.ac.upnvj.cloudlib;

import io.quarkus.hibernate.orm.panache.PanacheEntityBase;
import jakarta.persistence.*;

@Entity
@Table(name = "book_copy")
public class BookCopy extends PanacheEntityBase {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "tenant_id", nullable = false)
    public Long tenantId;

    @Column(name = "book_id", nullable = false)
    public Long bookId;

    @Column(nullable = false)
    public String barcode;

    @Column(nullable = false)
    public String status;
}
