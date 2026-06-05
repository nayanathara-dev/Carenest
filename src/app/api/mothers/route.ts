import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { sendMotherAccountCreatedEmail } from '@/lib/mailer';

function toNullableNumber(value: Prisma.Decimal | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

// Get all mothers
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '10');
    const search = searchParams.get('search') || '';
    const assignedMidwifeSearch = searchParams.get('assignedMidwife') || '';
    const assignmentStatus = searchParams.get('assignmentStatus') || 'all';
    const accountStatus = searchParams.get('accountStatus') || 'all';
    const bloodGroup = searchParams.get('bloodGroup') || '';
    const midwifeId = searchParams.get('midwifeId');

    const where: Prisma.MotherWhereInput = {};

    if (search) {
      where.OR = [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search, mode: 'insensitive' } } },
        { assignedMidwife: { user: { name: { contains: search, mode: 'insensitive' } } } },
        { assignedMidwife: { user: { email: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    if (assignedMidwifeSearch) {
      where.assignedMidwife = {
        user: {
          name: { contains: assignedMidwifeSearch, mode: 'insensitive' },
        },
      };
    }

    if (assignmentStatus === 'assigned') {
      where.assignedMidwifeId = { not: null };
    } else if (assignmentStatus === 'unassigned') {
      where.assignedMidwifeId = null;
    }

    if (accountStatus === 'active') {
      where.user = { is: { isActive: true } };
    } else if (accountStatus === 'inactive') {
      where.user = { is: { isActive: false } };
    }

    if (bloodGroup) {
      where.bloodGroup = bloodGroup;
    }

    if (midwifeId) {
      where.assignedMidwifeId = midwifeId;
    }

    // If user is a midwife, only show assigned mothers
    if (session.user.role === 'MIDWIFE' && session.user.midwifeId) {
      where.assignedMidwifeId = session.user.midwifeId;
    }

    const [mothers, total] = await Promise.all([
      prisma.mother.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              address: true,
              profileImage: true,
              isActive: true,
            },
          },
          assignedMidwife: {
            include: {
              user: {
                select: { name: true, email: true, phone: true },
              },
            },
          },
          pregnancies: {
            select: { id: true, status: true },
            orderBy: { createdAt: 'desc' },
          },
          children: {
            orderBy: { birthDate: 'desc' },
          },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.mother.count({ where }),
    ]);

    const normalizedMothers = mothers.map((mother: typeof mothers[number]) => ({
      ...mother,
      latitude: toNullableNumber(mother.latitude),
      longitude: toNullableNumber(mother.longitude),
    }));

    return NextResponse.json({
      data: normalizedMothers,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error('Get mothers error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch mothers' },
      { status: 500 }
    );
  }
}

// Create new mother (admin/midwife)
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !['ADMIN', 'MIDWIFE'].includes(session.user.role)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      name,
      email,
      password,
      phone,
      address,
      dateOfBirth,
      bloodGroup,
      emergencyContact,
      emergencyName,
      medicalHistory,
      allergies,
      mohRegistrationNumber,
      assignedMidwifeId,
    } = body;

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: 'Name, email, and password are required' },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 400 }
      );
    }

    const isAdmin = session.user.role === 'ADMIN';
    const normalizedAssignedMidwifeId = isAdmin
      ? (assignedMidwifeId || null)
      : (assignedMidwifeId || session.user.midwifeId || null);

    // Create user first
    const bcrypt = await import('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: 'MOTHER',
        phone,
        address,
        isActive: Boolean(normalizedAssignedMidwifeId),
      },
    });

    // Create mother profile
    const mother = await prisma.mother.create({
      data: {
        userId: user.id,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        bloodGroup,
        emergencyContact,
        emergencyName,
        medicalHistory,
        allergies,
        mohRegistrationNumber,
        assignedMidwifeId: normalizedAssignedMidwifeId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'MOTHER_CREATED',
        entity: 'Mother',
        entityId: mother.id,
        details: `Mother ${name} registered`,
      },
    });

    await sendMotherAccountCreatedEmail({
      motherName: user.name,
      motherEmail: user.email,
      loginPassword: password,
      hasAssignedMidwife: Boolean(normalizedAssignedMidwifeId),
    });

    return NextResponse.json({
      success: true,
      message: 'Mother registered successfully',
      data: mother,
    });
  } catch (error) {
    console.error('Create mother error:', error);
    return NextResponse.json(
      { error: 'Failed to register mother' },
      { status: 500 }
    );
  }
}
