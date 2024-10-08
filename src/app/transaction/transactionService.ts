import { StatusTransaction } from '@prisma/client'
import dotenv from 'dotenv'
import { MESSAGE_CODE } from '../../utils/ErrorCode'
import { AppError, HttpError } from '../../utils/HttpError'
import { MESSAGES } from '../../utils/Messages'
import { Meta } from '../../utils/Meta'
import { getProductById, updateProductStock } from '../product/productRepo'
import { TransactionBodyDTO, TransactionDetailDTO } from './transactionDTO'
import { getTransactionByIdMapper, getTransactionsMapper } from './transactionMapper'
import { cancelTransaction, createHistoryBaseOnTransaction, createIncomeByTransaction, createTransaction, createTransactionDetail, getHistoryByTransactionId, getMonthTransaction, getTodayTransaction, getTransaction, getTransactionById, getTransactionCount, getTransactionDetailByTransactionId, getWeekTransaction, updatePaymentTransaction, updateStatusTransaction } from './transactionRepo'
import { IFilterTransaction, TransactionModelTypes } from './transactionTypes'
import { createTransactionDetailValidate, createTransactionValidate, updatePaymentTransactionValidate, updateStatusToPaidTransactionValidate } from './transactionValidate'

dotenv.config()

export const createTransactionService = async ({ details, email, name, paymentMethod }: TransactionBodyDTO) => {

    const validateTransaction = await createTransactionValidate({ email, details, name, paymentMethod })
    if ((validateTransaction as HttpError)?.message) {
        return AppError((validateTransaction as HttpError).message, (validateTransaction as HttpError).statusCode, (validateTransaction as HttpError).code)
    }
    const transactionCreation = await createTransaction({ email, name, paymentMethod, details })
    const detailTransaction = details?.map(detail => ({ ...detail, transactionId: transactionCreation.id }))

    const validateTransactionDetail = await createTransactionDetailValidate(detailTransaction as TransactionDetailDTO[])

    if ((validateTransactionDetail as HttpError)?.message) {
        return AppError((validateTransactionDetail as HttpError).message, (validateTransactionDetail as HttpError).statusCode, (validateTransactionDetail as HttpError).code)
    }
    await createTransactionDetail({ details: detailTransaction })
    await createHistoryBaseOnTransaction(transactionCreation.id, 'UNPAID')
    console.time('createIncomeByTransaction')
    return transactionCreation
}

export const getTransactionDetailByTransactionIdService = async (transactionId: string) => {
    const transactionDetail = await getTransactionDetailByTransactionId(transactionId)
    return transactionDetail

}

export const getTransactionService = async ({ search = '', page = 1, perPage = 10, status, from, to }: IFilterTransaction) => {
    const fromDate = new Date(from as Date)
    const toDate = new Date(to as Date)



    // Menyesuaikan tanggal awal dan akhir pada hari yang sama
    const startDate = new Date(fromDate?.getFullYear(), fromDate?.getMonth(), fromDate?.getDate(), 0, 0, 0)
    const endDate = new Date(toDate?.getFullYear(), toDate?.getMonth(), toDate?.getDate(), 23, 59, 59)

    const filter = {
        search,
        status: status || undefined,
        page: Number(page) || undefined,
        perPage: Number(perPage) || undefined,
        from: from ? startDate : undefined,
        to: to ? endDate : undefined
    }
    const transactionData = await getTransaction(filter);
    const [transactions, totalTransaction] = await Promise.all([
        getTransactionsMapper(transactionData as unknown as TransactionModelTypes[]),
        getTransactionCount({
            search,
            status: status || undefined,
            from: from ? startDate : undefined,
            to: to ? endDate : undefined
        })])
    return { data: transactions, meta: Meta(page, perPage, totalTransaction) };
}

export const UpdateToPaidTransactionService = async ({ id }: TransactionBodyDTO) => {

    const validate = await updateStatusToPaidTransactionValidate(id as string);

    if ((validate as HttpError)?.message) {
        return AppError((validate as HttpError).message, (validate as HttpError).statusCode, (validate as HttpError).code)
    }

    const findTransaction = await getTransactionById(id as string)
    const promises = findTransaction?.transactionDetails?.map(async (item) => {
        const getProduct = await getProductById(item?.productId)
        await updateProductStock(getProduct?.id as string, (getProduct?.stock as number) - (item?.quantity as number))
        return []
    }) || []
    await Promise.all(promises)
    const updateTransaction = await updateStatusTransaction(id as string, 'PAID');
    await createHistoryBaseOnTransaction(id as string, 'PAID')
    return updateTransaction
}

export const getTransactionByIdService = async (id: string) => {
    const transaction = await getTransactionById(id)
    if (!transaction) {
        return AppError(MESSAGES.ERROR.NOT_FOUND.TRANSACTION, 404, MESSAGE_CODE.NOT_FOUND)
    }
    const transactionById = getTransactionByIdMapper(transaction as unknown as TransactionModelTypes)
    return transactionById
}

export const getHistoryByTransactionIdService = async (id: string) => {
    const transaction = await getTransactionById(id)
    if (!transaction) {
        return AppError(MESSAGES.ERROR.NOT_FOUND.TRANSACTION, 404, MESSAGE_CODE.NOT_FOUND)
    }
    const history = await getHistoryByTransactionId(id)
    return history
}

export const customUpdateStatusTransactionService = async (id: string, status: StatusTransaction) => {
    const transaction = await getTransactionById(id)
    if (!transaction) {
        return AppError(MESSAGES.ERROR.NOT_FOUND.TRANSACTION, 404, MESSAGE_CODE.NOT_FOUND)
    }
    if (status.toUpperCase() !== 'PAID' && status.toUpperCase() !== 'UNPAID' && status.toUpperCase() !== 'PROCESS_BY_KITCHEN') {
        return AppError(MESSAGES.ERROR.INVALID.STATUS, 400, MESSAGE_CODE.BAD_REQUEST)
    }

    const updateTransaction = await updateStatusTransaction(id, status.toUpperCase() as StatusTransaction);
    await createHistoryBaseOnTransaction(id, status.toUpperCase() as StatusTransaction)
    return updateTransaction
}

export const UpdatePaymentTransactionService = async (id: string, totalPaid: number) => {
    const validate = await updatePaymentTransactionValidate(id, totalPaid)
    if ((validate as HttpError)?.message) {
        return AppError((validate as HttpError).message, (validate as HttpError).statusCode, (validate as HttpError).code)
    }
    const transaction = await getTransactionById(id)
    const updatePayment = await updatePaymentTransaction(id, totalPaid, transaction?.totalAmount as number);
    await createIncomeByTransaction(id, transaction?.totalAmount as number)
    return updatePayment
}

export const handleWebhookTransactionService = async (settlementTime: string, signatureKey: string, transactionId: string, transactionStatus: string, totalPaid: number) => {
    if (transactionId && transactionStatus === 'settlement') {
        const transaction = await getTransactionById(transactionId)
        if (transaction) {
            const findTransaction = await getTransactionById(transactionId as string)
            const promises = findTransaction?.transactionDetails?.map(async (item) => {
                const getProduct = await getProductById(item?.productId)
                await updateProductStock(getProduct?.id as string, (getProduct?.stock as number) - (item?.quantity as number))
                return []
            }) || []
            await Promise.all(promises)
            const updateTransaction = await updateStatusTransaction(transactionId, 'PAID', settlementTime, signatureKey, totalPaid, findTransaction?.totalAmount);
            await createHistoryBaseOnTransaction(transactionId, 'PAID')
            await createIncomeByTransaction(transactionId, transaction.totalAmount)
            return updateTransaction
        }
    }

    return null

}

export const getTodayTransactionService = async () => {
    const getTransaction = await getTodayTransaction()
    return getTransaction
}
export const getWeekTransactionService = async () => {
    const getTransaction = await getWeekTransaction()
    return getTransaction
}

export const getMonthTransactionService = async (month: number) => {
    const getTransaction = await getMonthTransaction(month)
    return getTransaction
}

export const cancelTransactionService = async (id: string) => {
    const transaction = await getTransactionById(id)
    if (!transaction) {
        return AppError(MESSAGES.ERROR.NOT_FOUND.TRANSACTION, 404, MESSAGE_CODE.NOT_FOUND)
    }
    const updateTransaction = await cancelTransaction(id);
    await createHistoryBaseOnTransaction(id, 'CANCEL')
    return updateTransaction
}