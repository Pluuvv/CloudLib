package id.ac.upnvj.cloudlib;

import io.quarkus.hibernate.orm.panache.PanacheEntityBase;
import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "loan")
public class Loan extends PanacheEntityBase {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    public Long id;

    @Column(name = "tenant_id", nullable = false)
    public Long tenantId;

    @Column(name = "book_copy_id", nullable = false)
    public Long bookCopyId;

    @Column(name = "member_ref", nullable = false)
    public String memberRef;

    @Column(name = "borrowed_at", nullable = false)
    public Instant borrowedAt;

    @Column(name = "due_at", nullable = false)
    public Instant dueAt;

    @Column(name = "returned_at")
    public Instant returnedAt;
}
